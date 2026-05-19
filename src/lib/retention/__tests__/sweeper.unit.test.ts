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

const { runRetentionTick, sweepCustomer } = await import("../sweeper");

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
