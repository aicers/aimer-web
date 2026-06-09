import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { auditLogMock } = vi.hoisted(() => ({
  auditLogMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("../../audit", () => ({
  auditLog: (...args: unknown[]) => auditLogMock(...args),
}));

vi.mock("../../db/client", () => ({
  getAuthPool: () => ({ query: vi.fn() }),
}));

vi.mock("../../db/customer-runtime-pool", () => ({
  // Tests inject `connectCustomer` via deps, so the default factory
  // is never exercised here. A no-op stub keeps the module load
  // hermetic — no real `pg.Pool` is constructed for unit runs.
  getCustomerRuntimePool: () => {
    throw new Error(
      "getCustomerRuntimePool must not be invoked from unit tests — supply connectCustomer via deps",
    );
  },
}));

vi.mock("../../db/group-runtime-pool", () => ({
  // Tests inject `connectGroup` via deps; the default factory is never
  // exercised here, mirroring the customer-runtime-pool stub above.
  getGroupRuntimePool: () => {
    throw new Error(
      "getGroupRuntimePool must not be invoked from unit tests — supply connectGroup via deps",
    );
  },
}));

const {
  computeGroupRetentionBoundDays,
  reapGroupReports,
  runRetentionTick,
  sweepCustomer,
} = await import("../sweeper");

// ---------------------------------------------------------------------------
// In-memory fake customer-db client
// ---------------------------------------------------------------------------

type QueryHandler = (
  sql: string,
  params?: unknown[],
) => { rows: unknown[]; rowCount?: number };

interface QueryRecord {
  sql: string;
  params?: unknown[];
}

type SweeperConn = Awaited<
  ReturnType<Parameters<typeof sweepCustomer>[2]["connectCustomer"]>
>;

function makeConn(handler: QueryHandler) {
  const queries: QueryRecord[] = [];
  let ended = false;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return handler(sql, params);
  });
  const end = vi.fn(async () => {
    ended = true;
  });
  const conn: SweeperConn = {
    query: query as unknown as SweeperConn["query"],
    end,
  };
  return { conn, queries, isEnded: () => ended };
}

const NOW = new Date("2026-05-20T12:00:00Z");

function makeAuthPool(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return {
    pool: { query } as unknown as Parameters<
      typeof runRetentionTick
    >[0]["authPool"],
    query,
  };
}

beforeEach(() => {
  auditLogMock.mockReset();
  auditLogMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// sweepCustomer
// ---------------------------------------------------------------------------

describe("sweepCustomer", () => {
  function defaultHandler(): QueryHandler {
    return (sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ c: 0 }] };
      }
      return { rows: [], rowCount: 0 };
    };
  }

  it("emits tick_started after lock acquisition, before any sweep query", async () => {
    const { conn, queries } = makeConn(defaultHandler());
    let auditAtCall = -1;
    auditLogMock.mockImplementation(async () => {
      auditAtCall = queries.length;
    });

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    // The first audit emission must occur after BEGIN + lock
    // (2 queries) but before any DELETE.
    expect(queries[0].sql).toContain("BEGIN");
    expect(queries[1].sql).toContain("pg_try_advisory_xact_lock");
    expect(auditAtCall).toBe(2);

    const firstAudit = auditLogMock.mock.calls[0][0] as {
      action: string;
      details: {
        ingestion_days: number;
        analysis_days: number | null;
        cutoff_ingestion: string;
        cutoff_analysis: string | null;
      };
    };
    expect(firstAudit.action).toBe("retention_sweep.tick_started");
    expect(firstAudit.details.ingestion_days).toBe(365);
    expect(firstAudit.details.analysis_days).toBe(1095);
    expect(firstAudit.details.cutoff_ingestion).toBe(
      new Date(NOW.getTime() - 365 * 86_400_000).toISOString(),
    );
    expect(firstAudit.details.cutoff_analysis).toBe(
      new Date(NOW.getTime() - 1095 * 86_400_000).toISOString(),
    );
  });

  it("skips silently when the advisory lock is not acquired (no tick_started)", async () => {
    const { conn, queries } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: false }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    expect(outcome.status).toBe("skipped_lock");
    expect(auditLogMock).not.toHaveBeenCalled();
    // BEGIN, lock probe, ROLLBACK — no sweep query ran.
    expect(queries.map((q) => q.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BEGIN"),
        expect.stringContaining("pg_try_advisory_xact_lock"),
        expect.stringContaining("ROLLBACK"),
      ]),
    );
    expect(queries.some((q) => q.sql.toUpperCase().includes("DELETE"))).toBe(
      false,
    );
  });

  it("uses one stable cutoff per tick across every DELETE", async () => {
    const { conn, queries } = makeConn(defaultHandler());

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 30, analysis_days: 90 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    const cutoffIngestion = new Date(NOW.getTime() - 30 * 86_400_000);
    const cutoffAnalysis = new Date(NOW.getTime() - 90 * 86_400_000);

    const ingestionTables = [
      "DELETE FROM detection_events",
      "DELETE FROM baseline_event",
      "DELETE FROM story",
      "DELETE FROM policy_run",
    ];
    for (const stmt of ingestionTables) {
      const q = queries.find((r) => r.sql.includes(stmt));
      expect(q, `expected ${stmt}`).toBeDefined();
      expect((q?.params?.[0] as Date).getTime()).toBe(
        cutoffIngestion.getTime(),
      );
    }

    const analysisQ = queries.find((q) =>
      q.sql.includes("DELETE FROM event_analysis_result"),
    );
    expect(analysisQ).toBeDefined();
    expect((analysisQ?.params?.[0] as Date).getTime()).toBe(
      cutoffAnalysis.getTime(),
    );
  });

  it("does not sweep event_analysis_result when analysis_days is null", async () => {
    const { conn, queries } = makeConn(defaultHandler());

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: null },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    expect(
      queries.some((q) => q.sql.includes("DELETE FROM event_analysis_result")),
    ).toBe(false);
  });

  it("emits tick_completed only when at least one row was deleted", async () => {
    const { conn } = makeConn(defaultHandler());

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    const actions = auditLogMock.mock.calls.map(
      (call) => (call[0] as { action: string }).action,
    );
    expect(actions).toEqual(["retention_sweep.tick_started"]);
  });

  it("emits tick_completed with accurate deleted_by_table when deletions occur", async () => {
    const { conn } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("COUNT(*)") && sql.includes("story_member")) {
        return { rows: [{ c: 7 }] };
      }
      if (sql.includes("COUNT(*)") && sql.includes("policy_event")) {
        return { rows: [{ c: 5 }] };
      }
      if (sql.includes("DELETE FROM detection_events")) {
        return { rows: [], rowCount: 11 };
      }
      if (sql.includes("DELETE FROM baseline_event")) {
        return { rows: [], rowCount: 3 };
      }
      if (sql.includes("DELETE FROM story")) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("DELETE FROM policy_run")) {
        return { rows: [], rowCount: 4 };
      }
      if (sql.includes("DELETE FROM event_analysis_result")) {
        return { rows: [], rowCount: 6 };
      }
      if (sql.includes("DELETE FROM event_redaction_map")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    const completed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; details: unknown })
      .find((evt) => evt.action === "retention_sweep.tick_completed");
    expect(completed).toBeDefined();
    expect(
      (completed?.details as { deleted_by_table: unknown }).deleted_by_table,
    ).toEqual({
      detection_events: 11,
      baseline_event: 3,
      story: 2,
      story_member: 7,
      policy_run: 4,
      policy_event: 5,
      event_analysis_result: 6,
      event_redaction_map: 1,
    });
  });

  it("emits tick_failed after ROLLBACK on a thrown error", async () => {
    const boom = new Error("connection dropped");
    const { conn, queries } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("DELETE FROM detection_events")) {
        // Partial progress before the throw: detection_events
        // already deleted 9 rows in this call before the next
        // query throws.
        return { rows: [], rowCount: 9 };
      }
      if (sql.includes("DELETE FROM baseline_event")) {
        throw boom;
      }
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ c: 0 }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toBe("connection dropped");
    expect(queries.some((q) => q.sql.includes("ROLLBACK"))).toBe(true);

    const failed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; details: unknown })
      .find((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failed).toBeDefined();
    const failedDetails = failed?.details as {
      error_message: string;
      partial_deleted_by_table: { detection_events: number };
    };
    expect(failedDetails.error_message).toBe("connection dropped");
    expect(failedDetails.partial_deleted_by_table.detection_events).toBe(9);

    const completed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string })
      .find((evt) => evt.action === "retention_sweep.tick_completed");
    expect(completed).toBeUndefined();
  });

  it("locks parents FOR UPDATE before counting child rows", async () => {
    const { conn, queries } = makeConn(defaultHandler());

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    const storyForUpdate = queries.findIndex(
      (q) => q.sql.includes("FROM story") && q.sql.includes("FOR UPDATE"),
    );
    const storyMemberCount = queries.findIndex(
      (q) => q.sql.includes("COUNT(*)") && q.sql.includes("story_member"),
    );
    const storyDelete = queries.findIndex((q) =>
      q.sql.includes("DELETE FROM story"),
    );
    expect(storyForUpdate).toBeGreaterThanOrEqual(0);
    expect(storyForUpdate).toBeLessThan(storyMemberCount);
    expect(storyMemberCount).toBeLessThan(storyDelete);

    const runForUpdate = queries.findIndex(
      (q) => q.sql.includes("FROM policy_run") && q.sql.includes("FOR UPDATE"),
    );
    const policyEventCount = queries.findIndex(
      (q) => q.sql.includes("COUNT(*)") && q.sql.includes("policy_event"),
    );
    const runDelete = queries.findIndex((q) =>
      q.sql.includes("DELETE FROM policy_run"),
    );
    expect(runForUpdate).toBeGreaterThanOrEqual(0);
    expect(runForUpdate).toBeLessThan(policyEventCount);
    expect(policyEventCount).toBeLessThan(runDelete);
  });

  it("runs the map cascade pass with a deterministic FOR UPDATE order", async () => {
    const { conn, queries } = makeConn(defaultHandler());

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    const mapPass = queries.find((q) =>
      q.sql.includes("DELETE FROM event_redaction_map"),
    );
    expect(mapPass, "map cascade pass missing").toBeDefined();
    const sql = mapPass?.sql ?? "";
    expect(sql).toContain("ORDER BY aice_id, event_key");
    expect(sql).toContain("FOR UPDATE OF m");
    // Cascade must NOT consider story/policy_run as cascade inputs —
    // only story_member (joined through story) and policy_event
    // (joined through policy_run) count.
    expect(sql).toContain("story_member");
    expect(sql).toContain("policy_event");
    expect(sql).not.toMatch(/NOT EXISTS \([^)]*FROM story\b/);
    expect(sql).not.toMatch(/NOT EXISTS \([^)]*FROM policy_run\b/);
    // The cascade existence check uses pr.run_id (the actual PK)
    // not a non-existent pr.id.
    expect(sql).toMatch(/pr\.run_id\s*=\s*pe\.run_id/);
  });

  it("emits tick_failed when connectCustomer throws (no transaction to roll back)", async () => {
    const boom = new Error("customer DB unreachable");
    const connectCustomer = vi.fn().mockRejectedValue(boom);

    const outcome = await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer,
      },
      NOW,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toBe("customer DB unreachable");

    const failed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; details: unknown })
      .find((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failed).toBeDefined();
    const details = failed?.details as {
      error_message: string;
      partial_deleted_by_table: Record<string, number>;
    };
    expect(details.error_message).toBe("customer DB unreachable");
    // No queries executed so all counts must be zero.
    expect(details.partial_deleted_by_table).toEqual({
      detection_events: 0,
      baseline_event: 0,
      story: 0,
      story_member: 0,
      policy_run: 0,
      policy_event: 0,
      event_analysis_result: 0,
      event_redaction_map: 0,
    });
    // tick_started must not have been emitted.
    const started = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string })
      .find((evt) => evt.action === "retention_sweep.tick_started");
    expect(started).toBeUndefined();
  });

  it("emits tick_failed when BEGIN itself fails and does not attempt ROLLBACK", async () => {
    const boom = new Error("server unexpectedly closed connection");
    const { conn, queries } = makeConn((sql) => {
      if (sql === "BEGIN") {
        throw boom;
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toBe("server unexpectedly closed connection");
    expect(
      queries.some((q) => q.sql === "ROLLBACK"),
      "must not issue ROLLBACK when BEGIN failed",
    ).toBe(false);

    const failed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string })
      .find((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failed).toBeDefined();
  });

  it("emits tick_failed and rolls back when the advisory-lock query fails", async () => {
    const boom = new Error("lock query exploded");
    const { conn, queries } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        throw boom;
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toBe("lock query exploded");
    // BEGIN ran successfully, so ROLLBACK must follow.
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);

    const failed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string })
      .find((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failed).toBeDefined();
    // tick_started must not have been emitted (we never reached the
    // post-lock emission point).
    const started = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string })
      .find((evt) => evt.action === "retention_sweep.tick_started");
    expect(started).toBeUndefined();
  });

  it("ends the connection even when ROLLBACK is reached", async () => {
    const boom = new Error("disk full");
    const { conn, isEnded } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("DELETE FROM detection_events")) {
        throw boom;
      }
      return { rows: [], rowCount: 0 };
    });

    await sweepCustomer(
      "cust-1",
      { ingestion_days: 365, analysis_days: 1095 },
      {
        authPool: makeAuthPool([]).pool,
        connectCustomer: async () => conn,
      },
      NOW,
    );
    expect(isEnded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runRetentionTick
// ---------------------------------------------------------------------------

describe("runRetentionTick", () => {
  it("issues the customers join filtered to database_status = 'active'", async () => {
    const { pool, query } = makeAuthPool([]);
    await runRetentionTick({
      authPool: pool,
      connectCustomer: async () => {
        throw new Error("should not connect when no customers");
      },
      now: () => NOW,
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("LEFT JOIN customer_retention_policy");
    expect(sql).toMatch(/database_status\s*=\s*'active'/);
  });

  it("emits tick_failed with missing_retention_policy when policy join produces NULLs", async () => {
    const { pool } = makeAuthPool([
      {
        customer_id: "cust-no-policy",
        external_key: "key",
        ingestion_days: null,
        analysis_days: null,
      },
    ]);
    const connectCustomer = vi.fn();
    await runRetentionTick({
      authPool: pool,
      connectCustomer,
      now: () => NOW,
    });

    // No customer-db connection attempted.
    expect(connectCustomer).not.toHaveBeenCalled();

    const failed = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; details: unknown })
      .find((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failed).toBeDefined();
    const details = failed?.details as {
      error_message: string;
      partial_deleted_by_table: Record<string, unknown>;
    };
    expect(details.error_message).toBe("missing_retention_policy");
    expect(details.partial_deleted_by_table).toEqual({});
  });

  it("continues to remaining customers if one customer-db connection fails", async () => {
    const { pool } = makeAuthPool([
      {
        customer_id: "cust-a",
        external_key: "a",
        ingestion_days: 365,
        analysis_days: 1095,
      },
      {
        customer_id: "cust-b",
        external_key: "b",
        ingestion_days: 365,
        analysis_days: 1095,
      },
    ]);
    const connectCustomer = vi
      .fn()
      .mockRejectedValueOnce(new Error("a is down"))
      .mockImplementationOnce(async () => {
        return makeConn((sql) => {
          if (sql.includes("pg_try_advisory_xact_lock")) {
            return { rows: [{ locked: true }] };
          }
          if (sql.includes("COUNT(*)")) {
            return { rows: [{ c: 0 }] };
          }
          return { rows: [], rowCount: 0 };
        }).conn;
      });

    await runRetentionTick({
      authPool: pool,
      connectCustomer,
      now: () => NOW,
    });

    expect(connectCustomer).toHaveBeenCalledTimes(2);
    // The failed customer must surface as a persisted tick_failed
    // audit row, not just a stderr line — operators need that record.
    const failedActions = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; targetId: string })
      .filter((evt) => evt.action === "retention_sweep.tick_failed");
    expect(failedActions.some((evt) => evt.targetId === "cust-a")).toBe(true);
    // The second customer ran to completion (no rows deleted ⇒
    // tick_started only, no tick_completed).
    const startedForB = auditLogMock.mock.calls
      .map((call) => call[0] as { action: string; targetId: string })
      .filter(
        (evt) =>
          evt.action === "retention_sweep.tick_started" &&
          evt.targetId === "cust-b",
      );
    expect(startedForB.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeGroupRetentionBoundDays (#509)
// ---------------------------------------------------------------------------

describe("computeGroupRetentionBoundDays", () => {
  it("is unbounded (null) when group policy is NULL and every member analysis_days is NULL", () => {
    expect(
      computeGroupRetentionBoundDays(null, [
        { ingestion_days: 365, analysis_days: null },
        { ingestion_days: 30, analysis_days: null },
      ]),
    ).toBeNull();
  });

  it("is unbounded (null) when there are no members and no group policy", () => {
    expect(computeGroupRetentionBoundDays(null, [])).toBeNull();
  });

  it("drops a NULL group policy term out of the min (does not treat it as 0/finite)", () => {
    // group policy NULL ⇒ only the member H_c bounds: max(365, 1095) = 1095.
    expect(
      computeGroupRetentionBoundDays(null, [
        { ingestion_days: 365, analysis_days: 1095 },
      ]),
    ).toBe(1095);
  });

  it("drops a NULL member analysis_days out of the min but keeps finite members", () => {
    // Member A unbounded (H_c = ∞, dropped); member B H_c = max(30, 90) = 90.
    expect(
      computeGroupRetentionBoundDays(null, [
        { ingestion_days: 365, analysis_days: null },
        { ingestion_days: 30, analysis_days: 90 },
      ]),
    ).toBe(90);
  });

  it("takes the min across the group policy and every finite member H_c", () => {
    // group policy 200; H_c(A) = max(365, 1095) = 1095; H_c(B) = max(60, 45) = 60.
    expect(
      computeGroupRetentionBoundDays(200, [
        { ingestion_days: 365, analysis_days: 1095 },
        { ingestion_days: 60, analysis_days: 45 },
      ]),
    ).toBe(60);
  });

  it("uses H_c = max(ingestion_days, analysis_days) when ingestion dominates", () => {
    // ingestion 400 > analysis 90 ⇒ H_c = 400; the only term ⇒ bound 400.
    expect(
      computeGroupRetentionBoundDays(null, [
        { ingestion_days: 400, analysis_days: 90 },
      ]),
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// reapGroupReports + ordering inside runRetentionTick (#509)
// ---------------------------------------------------------------------------

type GroupConn = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<Parameters<typeof reapGroupReports>[0]["connectGroup"]>
    >
  >
>;

function makeGroupConn(rowCount = 0) {
  const queries: QueryRecord[] = [];
  let ended = false;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [], rowCount };
  });
  const conn: GroupConn = {
    query: query as unknown as GroupConn["query"],
    end: vi.fn(async () => {
      ended = true;
    }),
  };
  return { conn, queries, isEnded: () => ended };
}

// One (group × member) row as the auth-DB join produces it.
function groupRow(
  overrides: Partial<{
    group_id: string;
    group_policy_days: number | null;
    member_id: string | null;
    has_member_policy: boolean;
    member_ingestion_days: number | null;
    member_analysis_days: number | null;
  }> = {},
) {
  return {
    group_id: "grp-1",
    group_policy_days: null,
    member_id: "mem-1",
    has_member_policy: true,
    member_ingestion_days: 365,
    member_analysis_days: 1095,
    ...overrides,
  };
}

describe("reapGroupReports", () => {
  it("deletes historical rows by bucket_date excluding LIVE, with the bound cutoff", async () => {
    const { conn, queries } = makeGroupConn(3);
    const { pool } = makeAuthPool([
      groupRow({ member_ingestion_days: 30, member_analysis_days: 90 }),
    ]);

    await reapGroupReports(
      {
        authPool: pool,
        connectCustomer: async () => makeConn(() => ({ rows: [] })).conn,
        connectGroup: async () => conn,
      },
      NOW,
    );

    const del = queries.find((q) =>
      q.sql.includes("DELETE FROM periodic_report_result"),
    );
    expect(del, "expected group report DELETE").toBeDefined();
    // LIVE must never be reaped by bucket date.
    expect(del?.sql).toContain("period <> 'LIVE'");
    expect(del?.sql).toContain("bucket_date < $1");
    // bound = min(∞, max(30, 90)) = 90 days before NOW.
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    expect((del?.params?.[0] as Date).getTime()).toBe(cutoff.getTime());

    const reaped = auditLogMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            action: string;
            details: { deleted_periodic_report_result?: number };
          },
      )
      .find((e) => e.action === "retention_sweep.group_reaped");
    expect(reaped?.details.deleted_periodic_report_result).toBe(3);
  });

  it("skips and audits group_skipped when a member is missing its policy; never opens the group DB", async () => {
    const connectGroup = vi.fn();
    const { pool } = makeAuthPool([
      groupRow({ member_id: "mem-ok" }),
      groupRow({
        member_id: "mem-bad",
        has_member_policy: false,
        member_ingestion_days: null,
        member_analysis_days: null,
      }),
    ]);

    await reapGroupReports(
      {
        authPool: pool,
        connectCustomer: async () => makeConn(() => ({ rows: [] })).conn,
        connectGroup,
      },
      NOW,
    );

    expect(connectGroup).not.toHaveBeenCalled();
    const skipped = auditLogMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            action: string;
            details: { error_message?: string; member_id?: string };
          },
      )
      .find((e) => e.action === "retention_sweep.group_skipped");
    expect(skipped?.details.error_message).toBe("missing_retention_policy");
    expect(skipped?.details.member_id).toBe("mem-bad");
  });

  it("never opens the group DB for an unbounded group (NULL group policy + all members unbounded)", async () => {
    const connectGroup = vi.fn();
    const { pool } = makeAuthPool([
      groupRow({ group_policy_days: null, member_analysis_days: null }),
    ]);

    await reapGroupReports(
      {
        authPool: pool,
        connectCustomer: async () => makeConn(() => ({ rows: [] })).conn,
        connectGroup,
      },
      NOW,
    );

    expect(connectGroup).not.toHaveBeenCalled();
    expect(
      auditLogMock.mock.calls.some((c) =>
        (c[0] as { action: string }).action.startsWith(
          "retention_sweep.group_",
        ),
      ),
    ).toBe(false);
  });

  it("audits group_failed when the group DB connection throws", async () => {
    const connectGroup = vi
      .fn()
      .mockRejectedValue(new Error("group DB unreachable"));
    const { pool } = makeAuthPool([groupRow()]);

    await reapGroupReports(
      {
        authPool: pool,
        connectCustomer: async () => makeConn(() => ({ rows: [] })).conn,
        connectGroup,
      },
      NOW,
    );

    const failed = auditLogMock.mock.calls
      .map(
        (c) => c[0] as { action: string; details: { error_message?: string } },
      )
      .find((e) => e.action === "retention_sweep.group_failed");
    expect(failed?.details.error_message).toBe("group DB unreachable");
  });

  it("only processes active groups (the auth query filters database_status = 'active')", async () => {
    const { pool, query } = makeAuthPool([]);
    await reapGroupReports(
      {
        authPool: pool,
        connectCustomer: async () => makeConn(() => ({ rows: [] })).conn,
        connectGroup: async () => makeGroupConn().conn,
      },
      NOW,
    );
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/cg\.database_status\s*=\s*'active'/);
    expect(sql).toContain("FROM customer_groups cg");
    expect(sql).toContain("group_retention_policy");
    expect(sql).toContain("customer_group_members");
  });
});

describe("runRetentionTick group/customer ordering", () => {
  it("reaps group reports BEFORE the per-customer event_redaction_map sweep", async () => {
    const events: string[] = [];

    // Group conn records when the group report DELETE runs.
    const groupConn = (() => {
      const query = vi.fn(async (sql: string) => {
        if (String(sql).includes("DELETE FROM periodic_report_result")) {
          events.push("group_reap");
        }
        return { rows: [], rowCount: 1 };
      });
      return {
        query: query as unknown as GroupConn["query"],
        end: vi.fn(async () => {}),
      } satisfies GroupConn;
    })();

    // Customer conn records when the event_redaction_map cascade runs.
    const { conn: custConn } = makeConn((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock"))
        return { rows: [{ locked: true }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ c: 0 }] };
      if (sql.includes("DELETE FROM event_redaction_map")) {
        events.push("customer_map_sweep");
      }
      return { rows: [], rowCount: 0 };
    });

    // First authPool.query → the group join; second → the customers join.
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          groupRow({ member_ingestion_days: 30, member_analysis_days: 90 }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            customer_id: "cust-1",
            external_key: "k",
            ingestion_days: 365,
            analysis_days: 1095,
          },
        ],
      });
    const pool = { query } as unknown as Parameters<
      typeof runRetentionTick
    >[0]["authPool"];

    await runRetentionTick({
      authPool: pool,
      connectCustomer: async () => custConn,
      connectGroup: async () => groupConn,
      now: () => NOW,
    });

    expect(events).toEqual(["group_reap", "customer_map_sweep"]);
  });
});
