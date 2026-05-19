import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPoolQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: async (_customerId: string, map: unknown) => ({
    ciphertext: Buffer.from(JSON.stringify(map), "utf8"),
    wrappedDek: "vault:v1:map",
  }),
  decryptRedactionMap: async (_customerId: string, ciphertext: Buffer) =>
    JSON.parse(ciphertext.toString("utf8")),
}));

vi.mock("../../db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/client")>();
  return {
    ...actual,
    withTransaction: async <T>(
      _pool: unknown,
      fn: (client: { query: typeof mockClientQuery }) => Promise<T>,
    ): Promise<T> => {
      return fn({ query: mockClientQuery });
    },
  };
});

vi.mock("../../db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({
    query: mockPoolQuery,
    connect: mockConnect,
  }),
}));

const { storeApprovedEvents, InvalidPhase1PayloadError } = await import(
  "../event-storage"
);
const { buildRangeSet } = await import("@/lib/redaction");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_RANGES = buildRangeSet([]);

function plaintext(
  events: Array<{ event_key: string } & Record<string, unknown>>,
) {
  return Buffer.from(JSON.stringify({ events }), "utf8");
}

async function callStore(
  overrides?: Partial<{
    eventCount: number;
    plaintext: Buffer;
  }>,
) {
  return storeApprovedEvents({
    customerId: "00000000-0000-0000-0000-000000000001",
    aiceId: "aice-1",
    eventCount: 2,
    schemaVersion: "1.0",
    source: "manual",
    connectionId: null,
    ingestedBy: "acct-1",
    plaintext:
      overrides?.plaintext ??
      plaintext([
        { event_key: "1", body: "10.0.0.1 alpha" },
        { event_key: "2", body: "10.0.0.2 beta" },
      ]),
    ranges: EMPTY_RANGES,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClientRelease.mockReturnValue(undefined);
  // Default: the per-event loop performs:
  //   1. advisory lock SELECT  (returns rowCount; rows unused)
  //   2. SELECT existing map row (rows.length=0 ⇒ first writer)
  //   3. INSERT detection_events ON CONFLICT DO NOTHING RETURNING id
  //   4. INSERT event_redaction_map ON CONFLICT DO UPDATE
  // We answer in order with rowCount/rows shapes the code reads.
  let inserted = 0;
  mockClientQuery.mockImplementation((sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes("FROM event_redaction_map")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.includes("INSERT INTO detection_events")) {
      inserted += 1;
      return Promise.resolve({
        rows: [{ id: `event-id-${inserted}` }],
        rowCount: 1,
      });
    }
    if (sql.includes("INSERT INTO event_redaction_map")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeApprovedEvents", () => {
  it("fans out an N-event batch into N detection_events rows", async () => {
    const ids = await callStore();
    expect(ids).toEqual(["event-id-1", "event-id-2"]);

    const inserts = mockClientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO detection_events"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]?.[0]).toBe("aice-1");
    expect(inserts[0][1]?.[1]).toBe("1");
    expect(inserts[1][1]?.[1]).toBe("2");
  });

  it("stamps redaction_policy_version on every detection_events row", async () => {
    await callStore();
    const inserts = mockClientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO detection_events"),
    );
    for (const call of inserts) {
      const policyVersion = call[1]?.[3];
      expect(policyVersion).toMatch(/^engine:.+\|ranges:.+$/);
    }
  });

  it("writes one event_redaction_map row per event even when no entities matched", async () => {
    await callStore({
      plaintext: plaintext([
        { event_key: "1", body: "no entities" },
        { event_key: "2", body: "still no entities" },
      ]),
    });
    const mapWrites = mockClientQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO event_redaction_map"),
    );
    // existing === null branch fires twice (once per event).
    expect(mapWrites).toHaveLength(2);
  });

  it("rejects non-canonical event_key with invalid_plaintext", async () => {
    await expect(
      callStore({
        plaintext: plaintext([
          { event_key: "01", body: "x" },
          { event_key: "2", body: "y" },
        ]),
      }),
    ).rejects.toMatchObject({
      name: "InvalidPhase1PayloadError",
      reason: "invalid_plaintext",
    });
  });

  it("rejects mismatched event_count with event_count_mismatch", async () => {
    await expect(
      callStore({
        eventCount: 3,
        plaintext: plaintext([{ event_key: "1" }, { event_key: "2" }]),
      }),
    ).rejects.toMatchObject({
      name: "InvalidPhase1PayloadError",
      reason: "event_count_mismatch",
    });
  });

  it("rejects non-JSON plaintext with invalid_plaintext", async () => {
    await expect(
      callStore({
        eventCount: 1,
        plaintext: Buffer.from("not json", "utf8"),
      }),
    ).rejects.toBeInstanceOf(InvalidPhase1PayloadError);
  });

  it("attaches event_key context to RedactionInjectivityError from the engine", async () => {
    // Seed the existing map row with two tokens pointing to the same
    // value — the engine rejects this on load with
    // `RedactionInjectivityError`. The per-event loop must attach the
    // failing event_key so the outer audit row can identify the row.
    const corruptedMap = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.1" },
      "<<REDACTED_IP_002>>": { kind: "ip", value: "10.0.0.1" },
    };
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("FROM event_redaction_map")) {
        return Promise.resolve({
          rows: [
            {
              ciphertext: Buffer.from(JSON.stringify(corruptedMap), "utf8"),
              wrapped_dek: "vault:v1:map",
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    let caught: unknown;
    try {
      await callStore({
        eventCount: 1,
        plaintext: plaintext([{ event_key: "99", body: "x" }]),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name: string }).name).toBe("RedactionInjectivityError");
    expect((caught as { eventKey?: string }).eventKey).toBe("99");
  });
});
