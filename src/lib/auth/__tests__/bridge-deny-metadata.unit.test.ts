import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Issue #194: processBridgeCallback / denyConsumed must populate
// `requestedCustomerExternalKeys` and `matchedCustomerExternalKeys`
// on every scope-probing denial path so the callback route can record
// them in the bridge.connection_denied audit entry.

interface QueryRecord {
  match: RegExp;
  rows: unknown[];
}

let queue: QueryRecord[] = [];

function setQueue(records: QueryRecord[]) {
  queue = [...records];
}

const mockClient = {
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
    const idx = queue.findIndex((r) => r.match.test(sql));
    if (idx === -1) {
      // Return empty rows for unmatched (e.g. UPDATE pending_connections SET status='denied').
      return { rows: [], rowCount: 0 };
    }
    const rec = queue.splice(idx, 1)[0];
    return { rows: rec.rows, rowCount: rec.rows.length };
  }),
};

vi.mock("../../db/client", () => ({
  withTransaction: async (
    _pool: unknown,
    fn: (client: unknown) => Promise<unknown>,
  ): Promise<unknown> => fn(mockClient),
  query: vi.fn(),
}));

const PENDING_CONNECTION_BASE = {
  connection_id: "conn-1",
  jti: "jti-1",
  issuer: "https://aice.test",
  aice_id: "aice-test-1",
  sub: "user-1",
  status: "consumed",
  expires_at: new Date(Date.now() + 60_000),
};

describe("processBridgeCallback denial metadata (issue #194)", () => {
  beforeEach(() => {
    queue = [];
    mockClient.query.mockClear();
  });

  it("bridge_customer_mismatch carries requested + matched and aiceId", async () => {
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a", "ext-typo"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "active",
            env_status: "active",
          },
        ],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_customer_mismatch");
    expect(result.bridgeAiceId).toBe("aice-test-1");
    expect(result.requestedCustomerExternalKeys).toEqual(["ext-a", "ext-typo"]);
    expect(result.matchedCustomerExternalKeys).toEqual(["ext-a"]);
    // Acceptance: requested ∖ matched is non-empty for mismatch.
    const matched = new Set(result.matchedCustomerExternalKeys);
    const diff = (result.requestedCustomerExternalKeys ?? []).filter(
      (k) => !matched.has(k),
    );
    expect(diff.length).toBeGreaterThan(0);
  });

  it("bridge_customer_inactive includes the resolved key in matchedCustomerExternalKeys regardless of status", async () => {
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "suspended",
            env_status: "active",
          },
        ],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_customer_inactive");
    expect(result.bridgeAiceId).toBe("aice-test-1");
    expect(result.requestedCustomerExternalKeys).toEqual(["ext-a"]);
    expect(result.matchedCustomerExternalKeys).toEqual(["ext-a"]);
  });

  it("bridge_environment_inactive includes the resolved key regardless of env status", async () => {
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "active",
            env_status: "suspended",
          },
        ],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_environment_inactive");
    expect(result.bridgeAiceId).toBe("aice-test-1");
    expect(result.requestedCustomerExternalKeys).toEqual(["ext-a"]);
    expect(result.matchedCustomerExternalKeys).toEqual(["ext-a"]);
  });

  it("bridge_no_access carries metadata when account lacks membership/analyst access", async () => {
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "active",
            env_status: "active",
          },
        ],
      },
      {
        // access query — return no rows so bridge_no_access fires
        match: /account_customer_memberships|analyst_customer_assignments/,
        rows: [],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_no_access");
    expect(result.bridgeAiceId).toBe("aice-test-1");
    expect(result.requestedCustomerExternalKeys).toEqual(["ext-a"]);
    expect(result.matchedCustomerExternalKeys).toEqual(["ext-a"]);
  });

  it("dedupes duplicate requested keys so a single resolved match is not classified as bridge_customer_mismatch", async () => {
    // Reviewer round 1: a malformed sender or buggy registered sender that
    // emits `["ext-a", "ext-a"]` in customer_ids should not trip
    // bridge_customer_mismatch, because the only requested key resolves.
    // The validator dedupes upstream; this test exercises the bridge-layer
    // defense so the audit invariant (`requested ∖ matched` non-empty for
    // mismatch) holds even if a row is inserted outside the validator.
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a", "ext-a"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "active",
            env_status: "active",
          },
        ],
      },
      {
        match: /account_customer_memberships|analyst_customer_assignments/,
        rows: [{ customer_id: "uuid-a" }],
      },
      {
        match: /INSERT INTO sessions/,
        rows: [{ sid: "sess-1" }],
      },
      {
        match: /UPDATE staged_event_payloads/,
        rows: [],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    // No denial: deduped requested set [ext-a] equals matched set [ext-a].
    expect(result.deny).toBeUndefined();
    expect(result.sessionId).toBe("sess-1");
    expect(result.bridgeCustomerIds).toEqual(["uuid-a"]);
  });

  it("bridge_customer_mismatch with duplicates in raw row still preserves audit invariant", async () => {
    // Even if the row contains duplicates AND a real mismatch, the deduped
    // requested set must produce a non-empty `requested ∖ matched`.
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [
          {
            ...PENDING_CONNECTION_BASE,
            customer_ids: ["ext-a", "ext-a", "ext-typo"],
          },
        ],
      },
      {
        match: /FROM aice_environment_customers/,
        rows: [
          {
            customer_id: "uuid-a",
            external_key: "ext-a",
            customer_status: "active",
            env_status: "active",
          },
        ],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_customer_mismatch");
    expect(result.requestedCustomerExternalKeys).toEqual(["ext-a", "ext-typo"]);
    expect(result.matchedCustomerExternalKeys).toEqual(["ext-a"]);
    const matched = new Set(result.matchedCustomerExternalKeys);
    const diff = (result.requestedCustomerExternalKeys ?? []).filter(
      (k) => !matched.has(k),
    );
    expect(diff).toEqual(["ext-typo"]);
  });

  it("bridge_expired (no row from atomic consume) does not populate metadata", async () => {
    const { processBridgeCallback } = await import("../bridge");
    setQueue([
      {
        match: /UPDATE pending_connections[\s\S]*RETURNING/,
        rows: [],
      },
    ]);

    const result = await processBridgeCallback(
      {} as never,
      "conn-1",
      "account-1",
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(result.deny).toBe("bridge_expired");
    expect(result.requestedCustomerExternalKeys).toBeUndefined();
    expect(result.matchedCustomerExternalKeys).toBeUndefined();
  });
});
