import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/customer-runtime-pool", () => ({
  getCustomerRuntimePool: () => ({}),
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
}));

vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: vi.fn(),
  decryptRedactionMap: vi.fn(),
}));

const mockAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const {
  __testables,
  PER_ROW_SECONDS,
  installRedactionJobWorker,
  uninstallRedactionJobWorker,
  runOnceForTests,
} = await import("../redaction-job-worker");

describe("redaction-job-worker helpers", () => {
  it("exports the PER_ROW_SECONDS constant for the preview estimate", () => {
    expect(PER_ROW_SECONDS).toBeGreaterThan(0);
    expect(PER_ROW_SECONDS).toBe(0.05);
  });

  describe("substituteTokens", () => {
    it("replaces tokens with map values in string leaves", () => {
      const map = {
        "<<REDACTED_IP_001>>": { kind: "ip" as const, value: "10.0.0.1" },
      };
      const missing = new Set<string>();
      const out = __testables.substituteTokens(
        { line: "src=<<REDACTED_IP_001>> dst=10.0.0.2" },
        map,
        missing,
      );
      expect(out).toEqual({ line: "src=10.0.0.1 dst=10.0.0.2" });
      expect(missing.size).toBe(0);
    });

    it("restores DOMAIN tokens (RFC 0001 Amendment A.2 round-trip)", () => {
      const map = {
        "<<REDACTED_DOMAIN_001>>": {
          kind: "domain" as const,
          value: "vpn.customer.example",
        },
      };
      const missing = new Set<string>();
      const out = __testables.substituteTokens(
        { host: "<<REDACTED_DOMAIN_001>>" },
        map,
        missing,
      );
      expect(out).toEqual({ host: "vpn.customer.example" });
      expect(missing.size).toBe(0);
    });

    it("records missing tokens but leaves them literal", () => {
      const missing = new Set<string>();
      const out = __testables.substituteTokens(
        "no entry for <<REDACTED_IP_099>>",
        {},
        missing,
      );
      expect(out).toBe("no entry for <<REDACTED_IP_099>>");
      expect(missing.has("<<REDACTED_IP_099>>")).toBe(true);
    });

    it("walks nested objects + arrays", () => {
      const map = {
        "<<REDACTED_EMAIL_001>>": {
          kind: "email" as const,
          value: "alice@example.com",
        },
      };
      const missing = new Set<string>();
      const out = __testables.substituteTokens(
        {
          users: [
            { email: "<<REDACTED_EMAIL_001>>" },
            { email: "bob@example.com" },
          ],
        },
        map,
        missing,
      );
      expect(out).toEqual({
        users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      });
    });
  });

  describe("range-snapshot helpers", () => {
    it("recomputed hash equals the stored snapshot hash and target fragment", () => {
      const { snapshot, hash } = __testables.snapshotFromCidrs([
        "203.0.113.0/24",
        "10.0.0.0/8",
      ]);
      const recomputed = __testables.shortRangesHash(
        snapshot.cidrs
          .map((c) => c.cidr)
          .slice()
          .sort(),
      );
      expect(recomputed).toBe(hash);
    });

    it("targetHashFragment extracts the part after |ranges:", () => {
      expect(
        __testables.targetHashFragment("engine:1.0.0|ranges:abcdef012345"),
      ).toBe("abcdef012345");
      expect(__testables.targetHashFragment("garbage")).toBe("");
    });

    it("targetHashFragment isolates the ranges hash when a |domains: segment follows", () => {
      // RFC 0001 Amendment A.2: a `|domains:<short>` segment now trails
      // the ranges hash. The fragment must stop at the next `|` so
      // snapshot validation does not false-fail with policy_version_mismatch.
      expect(
        __testables.targetHashFragment(
          "engine:1.0.0|ranges:abcdef012345|domains:0011223344ff",
        ),
      ).toBe("abcdef012345");
      expect(
        __testables.targetHashFragment(
          "engine:1.0.0|ranges:empty|domains:empty",
        ),
      ).toBe("empty");
    });

    it("validateRangeSnapshot returns the rebuilt rangeset on the happy path", () => {
      const { snapshot, hash } = __testables.snapshotFromCidrs([
        "203.0.113.0/24",
      ]);
      const job = {
        id: "j",
        customer_id: "c",
        status: "running",
        target_policy_version: `engine:1.0.0|ranges:${hash}`,
        total_rows: 1,
        processed_rows: 0,
        failed_rows: 0,
        running_started_at: new Date(),
        started_at: new Date(),
        range_snapshot: snapshot,
        range_snapshot_ranges_hash: hash,
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      };
      const ranges = __testables.validateRangeSnapshot(job);
      expect(ranges.normalisedCidrs).toEqual(["203.0.113.0/24"]);
    });

    it("validateRangeSnapshot throws range_snapshot_corrupt on hash mismatch", () => {
      const { snapshot } = __testables.snapshotFromCidrs(["203.0.113.0/24"]);
      const job = {
        id: "j",
        customer_id: "c",
        status: "running",
        target_policy_version: "engine:1.0.0|ranges:deadbeef0001",
        total_rows: 1,
        processed_rows: 0,
        failed_rows: 0,
        running_started_at: new Date(),
        started_at: new Date(),
        range_snapshot: snapshot,
        // Wrong stored hash — not what the JSONB content recomputes to.
        range_snapshot_ranges_hash: "deadbeef0001",
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      };
      expect(() => __testables.validateRangeSnapshot(job)).toThrowError(
        "range_snapshot_corrupt",
      );
    });

    it("validateRangeSnapshot throws engine_version_unavailable on semver drift", () => {
      const { snapshot, hash } = __testables.snapshotFromCidrs([
        "203.0.113.0/24",
      ]);
      const job = {
        id: "j",
        customer_id: "c",
        status: "running",
        target_policy_version: `engine:1.0.0|ranges:${hash}`,
        total_rows: 1,
        processed_rows: 0,
        failed_rows: 0,
        running_started_at: new Date(),
        started_at: new Date(),
        range_snapshot: { ...snapshot, engine_semver: "9.9.9" },
        range_snapshot_ranges_hash: hash,
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      };
      expect(() => __testables.validateRangeSnapshot(job)).toThrowError(
        "engine_version_unavailable",
      );
    });

    it("validateRangeSnapshot throws range_snapshot_missing when fields are absent", () => {
      const job = {
        id: "j",
        customer_id: "c",
        status: "running",
        target_policy_version: "engine:1.0.0|ranges:abc",
        total_rows: 1,
        processed_rows: 0,
        failed_rows: 0,
        running_started_at: new Date(),
        started_at: new Date(),
        range_snapshot: null,
        range_snapshot_ranges_hash: null,
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      };
      expect(() => __testables.validateRangeSnapshot(job)).toThrowError(
        "range_snapshot_missing",
      );
    });
  });

  describe("owned-domain drift validation (RFC 0001 Amendment A.2)", () => {
    // A fake auth client returning a fixed owned-domain row set for the
    // single SELECT `loadAndValidateOwnedDomains` issues.
    const fakeAuthClient = (suffixes: string[]) =>
      ({
        query: async () => ({
          rows: suffixes.map((s) => ({ owned_domain_suffix: s })),
        }),
      }) as never;

    const domainsHash = (suffixes: string[]) =>
      __testables.shortDomainsHash(suffixes);

    it("targetDomainsFragment isolates the domains hash, throwing when absent", () => {
      expect(
        __testables.targetDomainsFragment(
          "engine:1.0.0|ranges:abcdef012345|domains:0011223344ff",
        ),
      ).toBe("0011223344ff");
      expect(
        __testables.targetDomainsFragment(
          "engine:1.0.0|ranges:empty|domains:empty",
        ),
      ).toBe("empty");
      // The segment is always stamped (`computePolicyVersion` hashes an
      // empty set to the `empty` sentinel, never omits it) — a version
      // without it is corrupt and must fail the job, not skip the
      // leak-prevention check.
      expect(() =>
        __testables.targetDomainsFragment("engine:1.0.0|ranges:abcdef012345"),
      ).toThrowError("target_domains_missing");
    });

    it("shortDomainsHash matches the engine's empty sentinel and is stable", () => {
      expect(__testables.shortDomainsHash([])).toBe("empty");
      expect(__testables.shortDomainsHash(["customer.example"])).toBe(
        __testables.shortDomainsHash(["customer.example"]),
      );
    });

    it("returns the live set when its hash matches the target version", async () => {
      const suffixes = ["customer.example"];
      const job = {
        customer_id: "c",
        target_policy_version: `engine:1.0.0|ranges:empty|domains:${domainsHash(
          suffixes,
        )}`,
      };
      const set = await __testables.loadAndValidateOwnedDomains(
        fakeAuthClient(suffixes),
        job,
      );
      expect(set.normalisedSuffixes).toEqual(["customer.example"]);
    });

    it("throws domain_policy_drift when the live set no longer matches the target", async () => {
      // Target version was stamped for [customer.example]; the live set
      // has since been emptied. Re-redacting reconstructed rows with the
      // empty set would leak a previously-tokenised owned domain, so the
      // job must fail before any row is processed.
      const job = {
        customer_id: "c",
        target_policy_version: `engine:1.0.0|ranges:empty|domains:${domainsHash(
          ["customer.example"],
        )}`,
      };
      await expect(
        __testables.loadAndValidateOwnedDomains(fakeAuthClient([]), job),
      ).rejects.toThrowError("domain_policy_drift");
    });

    it("throws target_domains_missing for a target with no domains segment", async () => {
      const job = {
        customer_id: "c",
        target_policy_version: "engine:1.0.0|ranges:empty",
      };
      await expect(
        __testables.loadAndValidateOwnedDomains(
          fakeAuthClient(["customer.example"]),
          job,
        ),
      ).rejects.toThrowError("target_domains_missing");
    });
  });

  describe("normaliseJobRow (BIGINT-as-string from pg)", () => {
    // Regression guard for the bug where the worker would read
    // `processed_rows`/`failed_rows`/`total_rows` as strings (pg's
    // default BIGINT mapping) and then do `processed += 1`, producing
    // string concatenation ("0" + 1 → "01"). After ~18 batched
    // increments the resulting digit-string would overflow BIGINT on
    // write-back. Normalisation must coerce these fields to numbers
    // at the read boundary.
    it("coerces BIGINT-as-string columns to numbers", () => {
      const out = __testables.normaliseJobRow({
        id: "j",
        customer_id: "c",
        status: "running",
        target_policy_version: "engine:1.0.0|ranges:abc",
        total_rows: "100",
        processed_rows: "10",
        failed_rows: "2",
        running_started_at: null,
        started_at: new Date(),
        range_snapshot: null,
        range_snapshot_ranges_hash: null,
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      });
      expect(out.total_rows).toBe(100);
      expect(out.processed_rows).toBe(10);
      expect(out.failed_rows).toBe(2);
      // The bug signature: adding 1 to the raw `pg` value yields
      // string concatenation. After normalisation it must add.
      const next = out.processed_rows + 1;
      expect(next).toBe(11);
      expect(next).not.toBe("101");
    });

    it("keeps total_rows null when pg returns null", () => {
      const out = __testables.normaliseJobRow({
        id: "j",
        customer_id: "c",
        status: "queued",
        target_policy_version: "engine:1.0.0|ranges:abc",
        total_rows: null,
        processed_rows: "0",
        failed_rows: "0",
        running_started_at: null,
        started_at: new Date(),
        range_snapshot: null,
        range_snapshot_ranges_hash: null,
        triggered_by: "u",
        cancelled_by: null,
        cancellation_reason: null,
      });
      expect(out.total_rows).toBeNull();
    });
  });

  describe("rowToCandidate primary key shape", () => {
    it("detection_events shape: { id }", () => {
      const c = __testables.rowToCandidate("detection_events", {
        id: "abc",
        aice_id: "A1",
        event_key: "100",
      });
      expect(c.primary_key).toEqual({ id: "abc" });
      expect(c.resolved_aice_id).toBe("A1");
      expect(c.resolved_event_key).toBe("100");
    });

    it("baseline_event shape: { baseline_version, event_key } with source_aice_id", () => {
      const c = __testables.rowToCandidate("baseline_event", {
        baseline_version: "v1",
        event_key: "200",
        source_aice_id: "A2",
      });
      expect(c.primary_key).toEqual({
        baseline_version: "v1",
        event_key: "200",
      });
      expect(c.resolved_aice_id).toBe("A2");
    });

    it("story_member shape captures the full PK including story_version", () => {
      const c = __testables.rowToCandidate("story_member", {
        story_id: "5",
        story_version: "vA",
        member_event_key: "300",
        source_aice_id: "A3",
      });
      expect(c.primary_key).toEqual({
        story_id: "5",
        story_version: "vA",
        member_event_key: "300",
      });
      expect(c.resolved_aice_id).toBe("A3");
      expect(c.resolved_event_key).toBe("300");
    });

    it("policy_event shape: { run_id, event_key }", () => {
      const c = __testables.rowToCandidate("policy_event", {
        run_id: "9",
        event_key: "400",
        source_aice_id: "A4",
      });
      expect(c.primary_key).toEqual({ run_id: "9", event_key: "400" });
      expect(c.resolved_aice_id).toBe("A4");
    });

    it("throws on null pk fields rather than coercing to 'null'", () => {
      // String(null) === "null" would silently flow into the table-
      // specific SQL casts and either misses the row or hits a generic
      // cast error. Reject at materialisation time so the failure
      // surfaces with the source_table in the message.
      expect(() =>
        __testables.rowToCandidate("detection_events", {
          id: null,
          aice_id: "A1",
          event_key: "100",
        }),
      ).toThrow(/detection_events/);
    });

    it("throws on missing pk fields (undefined) at materialisation", () => {
      expect(() =>
        __testables.rowToCandidate("baseline_event", {
          // baseline_version omitted
          event_key: "200",
          source_aice_id: "A2",
        }),
      ).toThrow(/baseline_event/);
    });

    it("event_analysis_result shape includes the model variant", () => {
      const c = __testables.rowToCandidate("event_analysis_result", {
        aice_id: "A5",
        event_key: "500",
        lang: "en",
        model_name: "gpt",
        model: "gpt-4o",
      });
      expect(c.primary_key).toEqual({
        aice_id: "A5",
        event_key: "500",
        lang: "en",
        model_name: "gpt",
        model: "gpt-4o",
      });
    });
  });

  describe("validatePrimaryKey (read-site Zod gate)", () => {
    it("accepts the canonical per-table shapes", () => {
      expect(
        __testables.validatePrimaryKey("detection_events", { id: "abc" }),
      ).toEqual({ id: "abc" });
      expect(
        __testables.validatePrimaryKey("event_analysis_result", {
          aice_id: "A1",
          event_key: "1",
          lang: "en",
          model_name: "gpt",
          model: "gpt-4o",
        }),
      ).toEqual({
        aice_id: "A1",
        event_key: "1",
        lang: "en",
        model_name: "gpt",
        model: "gpt-4o",
      });
    });

    it("rejects a JSONB shape with missing required keys", () => {
      // A row that survived rowToCandidate at some past worker version
      // but is now read back into a worker whose schema requires more
      // keys must fail loudly, not propagate `undefined` into a cast.
      expect(() =>
        __testables.validatePrimaryKey("story_member", {
          story_id: "1",
          // story_version intentionally omitted
          member_event_key: "300",
        }),
      ).toThrow(/story_member/);
    });

    it("rejects extra fields under strict mode", () => {
      expect(() =>
        __testables.validatePrimaryKey("detection_events", {
          id: "abc",
          extra: "nope",
        }),
      ).toThrow(/detection_events/);
    });

    it("rejects non-string values for required keys", () => {
      expect(() =>
        __testables.validatePrimaryKey("policy_event", {
          run_id: 9,
          event_key: "400",
        }),
      ).toThrow(/policy_event/);
    });

    it("rejects empty-string keys (would slip past String() coercion)", () => {
      expect(() =>
        __testables.validatePrimaryKey("detection_events", { id: "" }),
      ).toThrow(/detection_events/);
    });
  });
});

// ---------------------------------------------------------------------------
// Orchestration tests — mock the WorkerDeps injection seam to exercise
// the polling + recovery loops without a live database.
// ---------------------------------------------------------------------------

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeAuthClient(): MockClient {
  return { query: vi.fn(), release: vi.fn() };
}

function emptyAuthPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

describe("installRedactionJobWorker (HMR idempotency)", () => {
  afterEach(() => {
    uninstallRedactionJobWorker();
    mockAuditLog.mockReset();
  });

  it("does not spawn a second polling loop on a duplicate install", async () => {
    const authClient = makeAuthClient();
    // Recovery scan finds no running jobs; pollOnce finds no queued
    // jobs. The polling loop runs on setInterval which we never advance,
    // so this is effectively a no-op other than the timer registration.
    authClient.query.mockResolvedValue({ rows: [] });
    const deps = {
      authPool: emptyAuthPool() as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await installRedactionJobWorker(deps);
    const acquireCallsAfterFirst = deps.acquireAuthClient.mock.calls.length;
    await installRedactionJobWorker(deps);
    // The second install must early-return without invoking the
    // recovery scan again (which would re-acquire auth clients).
    expect(deps.acquireAuthClient.mock.calls.length).toBe(
      acquireCallsAfterFirst,
    );
  });

  it("does not spawn a second polling loop when two installs overlap", async () => {
    // Two concurrent installs (e.g. overlapping HMR reloads) must not
    // both race past the timer-null check before `runRecovery` returns
    // and end up registering two intervals. The `slot.installing`
    // promise is set synchronously before the first await, so the
    // second concurrent call awaits the same install instead of
    // starting its own.
    //
    // The recovery scan runs against `deps.authPool.query`; gate that
    // call on a manually-released promise so both installs are in
    // flight at the same time when the first one yields on its first
    // await. Without the in-progress sentinel, the second install
    // would observe `slot.timer === null`, race past the guard, and
    // run a second recovery scan.
    let resolveRecovery: () => void = () => {};
    const recoveryGate = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const poolQuery = vi.fn(async () => {
      await recoveryGate;
      return { rows: [] };
    });
    const deps = {
      authPool: { query: poolQuery } as never,
      acquireAuthClient: vi.fn(async () => makeAuthClient() as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    const first = installRedactionJobWorker(deps);
    const second = installRedactionJobWorker(deps);
    resolveRecovery();
    await Promise.all([first, second]);
    // Only one install must have run the recovery scan; the
    // overlapping second call must have awaited the in-flight install
    // instead of running its own recovery pass.
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

describe("runOnceForTests orchestration", () => {
  afterEach(() => {
    mockAuditLog.mockReset();
  });

  it("does nothing when there are no running or queued jobs", async () => {
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("BEGIN") || sql.includes("COMMIT")) return { rows: [] };
      // queued-row SELECT
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);
    // No queued row -> no audit emission, no customer-db connect.
    expect(mockAuditLog).not.toHaveBeenCalled();
    expect(deps.connectCustomer).not.toHaveBeenCalled();
  });

  it("acquires the per-customer range-mutation advisory lock inside the materialization transaction", async () => {
    // Drive tryStartQueuedJob through the queued-row pickup but force
    // the hash check to fail (policy_drift_between_trigger_and_start) so
    // we short-circuit before the customer-db scan. That still goes
    // through the new `pg_advisory_xact_lock(hashtext('redaction-ranges:…'))`
    // statement before the hash check, which is the contract we want
    // to assert: no race window between "is live CIDR set equal to
    // target" and the materialization is exposed because the same lock
    // POST / DELETE compete for is held throughout.
    const customerId = "c0000000-0000-0000-0000-000000000001";
    const queuedRow = {
      id: "j1",
      customer_id: customerId,
      status: "queued",
      target_policy_version: "engine:1.0.0|ranges:deadbeef0001",
      total_rows: null,
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: null,
      started_at: new Date(),
      range_snapshot: null,
      range_snapshot_ranges_hash: null,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("status = 'queued'")
      ) {
        return { rows: [queuedRow] };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM customer_redaction_ranges")) {
        // No CIDRs registered; recomputed hash will not match the
        // target fragment so the worker takes the policy-drift fail
        // branch and stops before any customer-db scan.
        return { rows: [] };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const calls = authClient.query.mock.calls.map((c) => ({
      sql: c[0] as string,
      args: c[1] as unknown[] | undefined,
    }));
    const lockCall = calls.find(
      (c) =>
        typeof c.sql === "string" &&
        c.sql.includes("pg_advisory_xact_lock(hashtext("),
    );
    expect(lockCall).toBeDefined();
    expect(lockCall?.args?.[0]).toBe(`redaction-ranges:${customerId}`);
    // Ordering invariant: BEGIN → range-mutation xact lock → CIDR
    // SELECT. If the SELECT ran before the lock, a concurrent POST /
    // DELETE could change CIDRs in the gap.
    const beginIdx = calls.findIndex(
      (c) => typeof c.sql === "string" && c.sql.trim() === "BEGIN",
    );
    const lockIdx = calls.findIndex(
      (c) =>
        typeof c.sql === "string" &&
        c.sql.includes("pg_advisory_xact_lock(hashtext("),
    );
    const cidrSelectIdx = calls.findIndex(
      (c) =>
        typeof c.sql === "string" &&
        c.sql.includes("FROM customer_redaction_ranges"),
    );
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(cidrSelectIdx).toBeGreaterThan(lockIdx);
  });

  it("emits retroactive_completed when recovery resumes a running job with no pending items", async () => {
    // Recovery-resume happy path: an authoritative running row is reclaimed
    // by runRecovery, processJobItems finds no pending items, finalizeJob's
    // conditional `status = 'running'` UPDATE matches (the row is still
    // running, no concurrent cancellation), and the worker emits
    // retroactive_completed — not the retroactive_started that earlier
    // versions inferred from counters and would duplicate on every
    // recovery pass.
    const customerId = "c0000000-0000-0000-0000-000000000010";
    const jobId = "j-recovery-happy";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "3",
      processed_rows: "3",
      failed_rows: "0",
      running_started_at: new Date(Date.now() - 5_000),
      started_at: new Date(Date.now() - 10_000),
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("FROM redaction_job_items") &&
        sql.includes("status = 'pending'")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'running'")
      ) {
        // Conditional finalize: row still running, flip succeeds.
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE redaction_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
        return { rows: [{ n: "0" }] };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain(
      "customer_redaction_ranges.retroactive_completed",
    );
    // Recovery must not re-fire retroactive_started — that audit is owned
    // by the queued -> running edge in tryStartQueuedJob.
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_started",
    );
    // No customer-db connection on the empty-batch path.
    expect(deps.connectCustomer).not.toHaveBeenCalled();
  });

  it("emits retroactive_cancelled when DELETE races the empty-batch finalize", async () => {
    // Round 5 race: processJobItems sees status='running' at the top-of-
    // loop check, the pending-items SELECT returns zero rows so the loop
    // returns outcome='completed', and a DELETE flips status to
    // 'cancelled' before finalizeJob's UPDATE lands. The conditional
    // UPDATE in finalizeJob (`WHERE id = ... AND status = 'running'`)
    // matches zero rows; the worker downgrades the effective outcome to
    // 'cancelled' and emits retroactive_cancelled instead of the wrong
    // retroactive_completed audit.
    const customerId = "c0000000-0000-0000-0000-000000000002";
    const jobId = "j-empty-cancel";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const baseRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "5",
      processed_rows: "3",
      failed_rows: "0",
      running_started_at: new Date(Date.now() - 10_000),
      started_at: new Date(Date.now() - 20_000),
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u1",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const cancelledRow = {
      ...baseRow,
      status: "cancelled",
      cancelled_by: "u2",
      cancellation_reason: "by operator",
    };
    let finalizeAttempted = false;
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [finalizeAttempted ? cancelledRow : baseRow] };
      }
      if (
        sql.includes("FROM redaction_job_items") &&
        sql.includes("status = 'pending'")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'running'")
      ) {
        // Simulate the race: DELETE has already flipped status to
        // 'cancelled', so the conditional UPDATE matches zero rows.
        finalizeAttempted = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE redaction_jobs")) {
        // Counter-only fallback UPDATE inside the downgrade path.
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
        return { rows: [{ n: "0" }] };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain(
      "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_completed",
    );
    const cancelledAudit = mockAuditLog.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(cancelledAudit).toBeDefined();
    const details = (
      cancelledAudit?.[0] as { details: Record<string, unknown> }
    ).details;
    expect(details.cancelledBy).toBe("u2");
    expect(details.cancellationReason).toBe("by operator");
  });

  it("emits retroactive_cancelled when DELETE races the zero-row completion", async () => {
    // Round 8 race: tryStartQueuedJob commits a no-op job as
    // status='running' with total_rows=0, and a DELETE flips the row to
    // 'cancelled' before runJobInner's zero-row terminal UPDATE lands.
    // The conditional UPDATE (`WHERE id = $1 AND status = 'running'`)
    // matches zero rows; the worker must emit retroactive_cancelled with
    // cancelled_by / cancellation_reason from the cancelled row, NOT
    // overwrite the cancellation with retroactive_completed.
    const customerId = "c0000000-0000-0000-0000-000000000099";
    const jobId = "j-zero-row-cancel";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const runningStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const cancelledAt = new Date("2026-01-01T00:01:00.000Z");
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "0",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: runningStartedAt,
      started_at: runningStartedAt,
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u1",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'completed'") &&
        sql.includes("status = 'running'")
      ) {
        // Race: DELETE has already flipped the row to 'cancelled', so the
        // conditional zero-row UPDATE matches zero rows.
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("SELECT completed_at, cancelled_by, cancellation_reason")
      ) {
        return {
          rows: [
            {
              completed_at: cancelledAt,
              cancelled_by: "u2",
              cancellation_reason: "operator-cancelled",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain(
      "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_completed",
    );
    const cancelledAudit = mockAuditLog.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(cancelledAudit).toBeDefined();
    const details = (
      cancelledAudit?.[0] as { details: Record<string, unknown> }
    ).details;
    expect(details.cancelledBy).toBe("u2");
    expect(details.cancellationReason).toBe("operator-cancelled");
    expect(details.processedRows).toBe(0);
    expect(details.failedRows).toBe(0);
    expect(details.skippedRows).toBe(0);
    expect(details.durationMs).toBe(
      cancelledAt.getTime() - runningStartedAt.getTime(),
    );
  });

  it("defers a per-row markItem failure instead of failing the whole job", async () => {
    // Round 5 fix: an auth-db blip while writing a per-row 'skipped' /
    // 'failed' mark must leave the item pending and let the next pass
    // retry — it must not bubble out of runJobInner as the job-wide
    // `retroactive_failed`, because no item status was durably recorded.
    const customerId = "c0000000-0000-0000-0000-000000000003";
    const jobId = "j-mark-deferral";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "10",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: new Date(),
      started_at: new Date(),
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    let pendingDelivered = false;
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("FROM redaction_job_items") &&
        sql.includes("status = 'pending'")
      ) {
        if (!pendingDelivered) {
          pendingDelivered = true;
          return {
            rows: [
              {
                job_id: jobId,
                seq: "1",
                source_table: "detection_events",
                primary_key: { id: "row1" },
                resolved_aice_id: "A1",
                resolved_event_key: "100",
                status: "pending",
              },
            ],
          };
        }
        // Second pass: simulate the deferred item being picked up by a
        // future run; the current run must then break cleanly so we can
        // assert the job-level outcome.
        return { rows: [] };
      }
      // Simulate auth-db blip on the per-row markItem write.
      if (
        sql.includes("UPDATE redaction_job_items") &&
        sql.includes("SET status = $1")
      ) {
        throw new Error("auth-db transient failure");
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'running'")
      ) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE redaction_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
        return { rows: [{ n: "0" }] };
      }
      return { rows: [] };
    });
    // Customer-db: row missing (skipped path) — the simplest path that
    // exercises the action-mark deferral introduced by the Round 5 fix.
    const customerClient = makeAuthClient();
    customerClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (
        sql.startsWith("BEGIN") ||
        sql.startsWith("ROLLBACK") ||
        sql.startsWith("COMMIT")
      ) {
        return { rows: [] };
      }
      // fetchRedactedRow returns no rows -> action.kind='skipped'
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => customerClient as never),
    };
    await runOnceForTests(deps);

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    // The transient markItem failure must NOT escalate to a job-wide
    // retroactive_failed audit. The item is left pending, the counter
    // is not bumped, and the outer loop finishes cleanly when the next
    // pending-items SELECT returns empty.
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_failed",
    );
  });

  it("acquires the per-event advisory lock before fetching the referent row", async () => {
    // Round 6 fix: the per-event advisory lock that serializes the
    // worker against same-(aice_id,event_key) live ingestion must be
    // taken immediately after BEGIN — before fetchRedactedRow — so the
    // worker's view of the referent row and its idempotency check are
    // taken inside the serialized region. If the lock came after the
    // fetch (the prior bug), a live ingest could land between the
    // worker's read and update and the worker would overwrite the
    // freshly-stamped row with the frozen job target.
    const customerId = "c0000000-0000-0000-0000-000000000004";
    const jobId = "j-event-lock-order";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "1",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: new Date(),
      started_at: new Date(),
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    let pendingDelivered = false;
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("FROM redaction_job_items") &&
        sql.includes("status = 'pending'")
      ) {
        if (!pendingDelivered) {
          pendingDelivered = true;
          return {
            rows: [
              {
                job_id: jobId,
                seq: "1",
                source_table: "detection_events",
                primary_key: { id: "row1" },
                resolved_aice_id: "A1",
                resolved_event_key: "100",
                status: "pending",
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'running'")
      ) {
        return { rows: [{ completed_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("UPDATE redaction_jobs")) {
        return { rows: [{ completed_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
        return { rows: [{ n: "0" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const customerCalls: Array<{ sql: string }> = [];
    const customerClient = makeAuthClient();
    customerClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql === "string") customerCalls.push({ sql });
      if (typeof sql !== "string") return { rows: [] };
      // fetchRedactedRow returns no rows -> action.kind='skipped'.
      // This is enough to exercise the BEGIN -> lock -> fetch ordering
      // without entering the map / update path.
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => customerClient as never),
    };
    await runOnceForTests(deps);

    const beginIdx = customerCalls.findIndex((c) => c.sql.startsWith("BEGIN"));
    const lockIdx = customerCalls.findIndex((c) =>
      c.sql.includes("pg_advisory_xact_lock(hashtextextended("),
    );
    const fetchIdx = customerCalls.findIndex(
      (c) =>
        c.sql.includes("FROM detection_events") && c.sql.includes("WHERE id"),
    );
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(fetchIdx).toBeGreaterThan(lockIdx);
  });

  it("emits retroactive_cancelled when DELETE races the snapshot-validation failure", async () => {
    // Round 9 race: recovery/poll loads a `running` row, a DELETE flips
    // it to `cancelled`, then validateRangeSnapshot throws (e.g. the
    // snapshot is missing/corrupt). The pre-processing failure UPDATE
    // must be gated on `status='running'`; when it matches zero rows the
    // worker emits `retroactive_cancelled` (preserving the operator's
    // cancellation) instead of overwriting it with `retroactive_failed`.
    const customerId = "c0000000-0000-0000-0000-000000000098";
    const jobId = "j-snapshot-fail-cancel";
    const runningStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const cancelledAt = new Date("2026-01-01T00:00:30.000Z");
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: "engine:1.0.0|ranges:deadbeef0001",
      total_rows: "5",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: runningStartedAt,
      started_at: runningStartedAt,
      // Force validateRangeSnapshot to throw range_snapshot_missing.
      range_snapshot: null,
      range_snapshot_ranges_hash: null,
      triggered_by: "u1",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'failed'") &&
        sql.includes("status = 'running'")
      ) {
        // DELETE has already flipped the row to 'cancelled'; the
        // conditional failure UPDATE matches zero rows.
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("SELECT completed_at, cancelled_by, cancellation_reason")
      ) {
        return {
          rows: [
            {
              completed_at: cancelledAt,
              cancelled_by: "u2",
              cancellation_reason: "operator-cancelled",
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
        return { rows: [{ n: "0" }] };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain(
      "customer_redaction_ranges.retroactive_cancelled",
    );
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_failed",
    );
    const cancelledAudit = mockAuditLog.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "customer_redaction_ranges.retroactive_cancelled",
    );
    const details = (
      cancelledAudit?.[0] as { details: Record<string, unknown> }
    ).details;
    expect(details.cancelledBy).toBe("u2");
    expect(details.cancellationReason).toBe("operator-cancelled");
    expect(details.durationMs).toBe(
      cancelledAt.getTime() - runningStartedAt.getTime(),
    );
  });

  it("skips an item when the referent row is deleted between fetch and update", async () => {
    // Round 9 race: the per-event advisory lock serializes the worker
    // against live ingestion for the same `(aice_id, event_key)`, but a
    // retention/cascade delete from another path can still remove the
    // row between fetchRedactedRow's SELECT and updateRedactedRow's
    // UPDATE inside the same customer-db transaction. The UPDATE then
    // affects zero rows and the worker must mark the item `skipped`
    // (row_missing) and rollback — NOT mark it `done` and recreate the
    // event_redaction_map row for a referent that no longer exists.
    const customerId = "c0000000-0000-0000-0000-000000000097";
    const jobId = "j-referent-deleted";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      total_rows: "1",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: new Date(),
      started_at: new Date(),
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    let pendingDelivered = false;
    const markedItems: Array<{ status: string; reason: string | null }> = [];
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(
      async (sql: string, args?: unknown[]) => {
        if (typeof sql !== "string") return { rows: [] };
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) return { rows: [] };
        if (
          sql.includes("FROM redaction_jobs") &&
          sql.includes("range_snapshot_ranges_hash") &&
          sql.includes("WHERE id = $1")
        ) {
          return { rows: [runningRow] };
        }
        if (
          sql.includes("FROM redaction_job_items") &&
          sql.includes("status = 'pending'")
        ) {
          if (!pendingDelivered) {
            pendingDelivered = true;
            return {
              rows: [
                {
                  job_id: jobId,
                  seq: "1",
                  source_table: "detection_events",
                  primary_key: { id: "row-deleted" },
                  resolved_aice_id: "A1",
                  resolved_event_key: "100",
                  status: "pending",
                },
              ],
            };
          }
          return { rows: [] };
        }
        if (
          sql.includes("UPDATE redaction_job_items") &&
          sql.includes("SET status = $1")
        ) {
          const status = (args?.[0] as string) ?? "";
          const reason = (args?.[1] as string | null) ?? null;
          markedItems.push({ status, reason });
          return { rows: [], rowCount: 1 };
        }
        if (
          sql.includes("UPDATE redaction_jobs") &&
          sql.includes("status = 'running'")
        ) {
          return { rows: [{ completed_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes("UPDATE redaction_jobs")) {
          return { rows: [{ completed_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes("COUNT(*)") && sql.includes("status = 'skipped'")) {
          return { rows: [{ n: "1" }] };
        }
        return { rows: [] };
      },
    );
    const customerCalls: Array<{ sql: string }> = [];
    const customerClient = makeAuthClient();
    customerClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql === "string") customerCalls.push({ sql });
      if (typeof sql !== "string") return { rows: [] };
      if (
        sql.startsWith("BEGIN") ||
        sql.startsWith("ROLLBACK") ||
        sql.startsWith("COMMIT")
      ) {
        return { rows: [] };
      }
      // Per-event advisory lock.
      if (sql.includes("pg_advisory_xact_lock(hashtextextended(")) {
        return { rows: [] };
      }
      // fetchRedactedRow: row still exists at SELECT time with an OLD
      // policy version so we enter the redact + update branch (not the
      // idempotency short-circuit).
      if (sql.includes("FROM detection_events") && sql.includes("WHERE id")) {
        return {
          rows: [
            {
              redacted_event: {},
              redaction_policy_version: "engine:1.0.0|ranges:oldoldoldold",
            },
          ],
        };
      }
      // readMap: no existing map.
      if (sql.includes("FROM event_redaction_map")) {
        return { rows: [] };
      }
      // updateRedactedRow: referent deleted between fetch and update.
      // rowCount=0 must drive the row_missing skipped path.
      if (sql.includes("UPDATE detection_events")) {
        return { rows: [], rowCount: 0 };
      }
      // upsertMap must NOT be reached on the rowCount=0 path. Throw if
      // it is so the assertion failure is loud.
      if (sql.includes("INSERT INTO event_redaction_map")) {
        throw new Error("upsertMap reached on the referent-deleted path");
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => customerClient as never),
    };
    await runOnceForTests(deps);

    // The item must be marked `skipped` with reason `row_missing`, NOT
    // `done` (which would leave a stranded map entry for a deleted
    // referent and falsely claim re-redaction success).
    expect(markedItems).toHaveLength(1);
    expect(markedItems[0]).toEqual({
      status: "skipped",
      reason: "row_missing",
    });
    // The customer-db transaction must end in ROLLBACK on this path —
    // we never want a COMMIT that could persist a partial side effect.
    const sqls = customerCalls.map((c) => c.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");

    const auditActions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    // No row-failed escalation; the row is durably skipped.
    expect(auditActions).not.toContain(
      "customer_redaction_ranges.retroactive_failed",
    );
  });

  it("uses DB-written completed_at to compute retroactive_completed.durationMs", async () => {
    // Round 6 fix: the issue requires
    //   duration_ms = completed_at - running_started_at,
    // where completed_at is the persisted DB timestamp. The audit must
    // read completed_at from the terminal UPDATE's RETURNING clause —
    // not Date.now() at the app layer — so DB/app clock skew and the
    // audit-hop latency after the terminal UPDATE cannot drift the
    // value away from the row's persisted timestamp.
    const customerId = "c0000000-0000-0000-0000-000000000005";
    const jobId = "j-duration-completed-at";
    const { snapshot, hash } = __testables.snapshotFromCidrs([]);
    const targetPolicyVersion = `engine:1.0.0|ranges:${hash}|domains:empty`;
    // Choose timestamps with a wide gap; the audit must reflect this
    // exact gap and not a Date.now() snapshot.
    const runningStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:42:00.000Z");
    const expectedDurationMs =
      completedAt.getTime() - runningStartedAt.getTime();
    const runningRow = {
      id: jobId,
      customer_id: customerId,
      status: "running",
      target_policy_version: targetPolicyVersion,
      // total_rows=0 routes through the zero-row completion path, which
      // is the path the reviewer explicitly called out alongside the
      // normal path.
      total_rows: "0",
      processed_rows: "0",
      failed_rows: "0",
      running_started_at: runningStartedAt,
      started_at: runningStartedAt,
      range_snapshot: snapshot,
      range_snapshot_ranges_hash: hash,
      triggered_by: "u",
      cancelled_by: null,
      cancellation_reason: null,
    };
    const authClient = makeAuthClient();
    authClient.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (
        sql.includes("FROM redaction_jobs") &&
        sql.includes("range_snapshot_ranges_hash") &&
        sql.includes("WHERE id = $1")
      ) {
        return { rows: [runningRow] };
      }
      if (
        sql.includes("UPDATE redaction_jobs") &&
        sql.includes("status = 'completed'") &&
        sql.includes("RETURNING completed_at")
      ) {
        return { rows: [{ completed_at: completedAt }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const deps = {
      authPool: {
        query: vi.fn(async (sql: string) => {
          if (typeof sql === "string" && sql.includes("status = 'running'")) {
            return { rows: [{ id: jobId, customer_id: customerId }] };
          }
          return { rows: [] };
        }),
      } as never,
      acquireAuthClient: vi.fn(async () => authClient as never),
      connectCustomer: vi.fn(async () => makeAuthClient() as never),
    };
    await runOnceForTests(deps);

    const completedAudit = mockAuditLog.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "customer_redaction_ranges.retroactive_completed",
    );
    expect(completedAudit).toBeDefined();
    const details = (
      completedAudit?.[0] as { details: Record<string, unknown> }
    ).details;
    expect(details.durationMs).toBe(expectedDurationMs);
  });
});
