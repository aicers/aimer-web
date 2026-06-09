import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuditLog = vi.fn();
vi.mock("../../audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const mockDeleteTransitKey = vi.fn().mockResolvedValue(undefined);
vi.mock("../../crypto/transit", () => ({
  getTransitConfig: () => ({ addr: "http://mock:8200", token: "mock" }),
  deleteTransitKey: (...args: unknown[]) => mockDeleteTransitKey(...args),
}));

const mockAnonymizeGroupAuditLogs = vi.fn().mockResolvedValue(undefined);
vi.mock("../../audit/anonymize", () => ({
  anonymizeGroupAuditLogs: (...args: unknown[]) =>
    mockAnonymizeGroupAuditLogs(...args),
}));

const { teardownGroupDb } = await import("../teardown-group");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GROUP_ID = "a0000000-0000-0000-0000-000000000001";

const ACTOR_CONTEXT = {
  actorId: "manager-1",
  authContext: "general" as const,
  ipAddress: "10.0.0.1",
  sid: "sid-1",
};

/** Mock Pool.prototype so `new Pool()` inside teardownGroupDb works. */
function mockPoolPrototype(opts?: { dbExists?: boolean }) {
  const dbExists = opts?.dbExists ?? true;
  vi.spyOn(Pool.prototype, "query").mockImplementation(async (sql) => {
    if (typeof sql === "string" && sql.includes("pg_database")) {
      return {
        rows: dbExists ? [{ "?column?": 1 }] : [],
        command: "",
        rowCount: dbExists ? 1 : 0,
        oid: 0,
        fields: [],
      } as never;
    }
    return {
      rows: [],
      command: "",
      rowCount: 0,
      oid: 0,
      fields: [],
    } as never;
  });
  vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("teardownGroupDb", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("emits group_db.dropped when database exists", async () => {
    mockPoolPrototype({ dbExists: true });

    await teardownGroupDb({} as never, GROUP_ID, ACTOR_CONTEXT, {
      adminUrl: "postgresql://localhost/test",
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "manager-1",
        authContext: "general",
        action: "group_db.dropped",
        targetType: "group_db",
        targetId: GROUP_ID,
      }),
    );
  });

  it("does not emit group_db.dropped when database does not exist", async () => {
    mockPoolPrototype({ dbExists: false });

    await teardownGroupDb({} as never, GROUP_ID, ACTOR_CONTEXT, {
      adminUrl: "postgresql://localhost/test",
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    expect(mockAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "group_db.dropped" }),
    );
  });

  it("anonymizes audit logs before destroying the Transit key", async () => {
    mockPoolPrototype({ dbExists: true });
    const order: string[] = [];
    mockAnonymizeGroupAuditLogs.mockImplementationOnce(async () => {
      order.push("anonymize");
    });
    mockDeleteTransitKey.mockImplementationOnce(async () => {
      order.push("destroy");
    });

    await teardownGroupDb({} as never, GROUP_ID, ACTOR_CONTEXT, {
      adminUrl: "postgresql://localhost/test",
    });

    expect(order).toEqual(["anonymize", "destroy"]);
  });

  it("emits openbao.dek_destroyed after deleting the Transit key", async () => {
    mockPoolPrototype({ dbExists: true });

    await teardownGroupDb({} as never, GROUP_ID, ACTOR_CONTEXT, {
      adminUrl: "postgresql://localhost/test",
      skipAuditAnonymize: true,
    });

    expect(mockDeleteTransitKey).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "manager-1",
        authContext: "general",
        action: "openbao.dek_destroyed",
        targetType: "transit_key",
      }),
    );
  });

  it("does not emit audit events when actorContext is omitted", async () => {
    mockPoolPrototype({ dbExists: true });

    await teardownGroupDb({} as never, GROUP_ID, undefined, {
      adminUrl: "postgresql://localhost/test",
      skipTransit: true,
      skipAuditAnonymize: true,
    });

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
