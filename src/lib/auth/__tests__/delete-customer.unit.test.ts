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

vi.mock("../../audit/anonymize", () => ({
  anonymizeCustomerAuditLogs: vi.fn().mockResolvedValue(undefined),
}));

const { deleteCustomer } = await import("../delete-customer");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOMER_ID = "a0000000-0000-0000-0000-000000000001";

const ACTOR_CONTEXT = {
  actorId: "admin-1",
  authContext: "admin" as const,
  ipAddress: "10.0.0.1",
  sid: "sid-1",
};

function makeAuthPool() {
  const client = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("DELETE FROM customers")) {
        return { rows: [{ id: CUSTOMER_ID }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn(),
  };
}

/** Mock Pool.prototype so `new Pool()` inside deleteCustomer works. */
function mockPoolPrototype(opts?: { dbExists?: boolean }) {
  const dbExists = opts?.dbExists ?? true;
  vi.spyOn(Pool.prototype, "query").mockImplementation(async (sql) => {
    // pg_database existence check
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

describe("deleteCustomer audit emissions", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("emits customer_db.dropped when database exists", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype({ dbExists: true });

    await deleteCustomer(
      authPool as never,
      {} as never,
      CUSTOMER_ID,
      ACTOR_CONTEXT,
      {
        adminUrl: "postgresql://localhost/test",
        skipTransit: true,
        skipAuditAnonymize: true,
      },
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        authContext: "admin",
        action: "customer_db.dropped",
        targetType: "customer_db",
        targetId: CUSTOMER_ID,
        customerId: CUSTOMER_ID,
      }),
    );
  });

  it("does not emit customer_db.dropped when database does not exist", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype({ dbExists: false });

    await deleteCustomer(
      authPool as never,
      {} as never,
      CUSTOMER_ID,
      ACTOR_CONTEXT,
      {
        adminUrl: "postgresql://localhost/test",
        skipTransit: true,
        skipAuditAnonymize: true,
      },
    );

    expect(mockAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "customer_db.dropped" }),
    );
  });

  it("emits openbao.dek_destroyed after deleting Transit key", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype({ dbExists: true });

    await deleteCustomer(
      authPool as never,
      {} as never,
      CUSTOMER_ID,
      ACTOR_CONTEXT,
      {
        adminUrl: "postgresql://localhost/test",
        skipAuditAnonymize: true,
      },
    );

    expect(mockDeleteTransitKey).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        authContext: "admin",
        action: "openbao.dek_destroyed",
        targetType: "transit_key",
        customerId: CUSTOMER_ID,
      }),
    );
  });

  it("does not emit audit events when actorContext is omitted", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype({ dbExists: true });

    await deleteCustomer(
      authPool as never,
      {} as never,
      CUSTOMER_ID,
      undefined,
      {
        adminUrl: "postgresql://localhost/test",
        skipTransit: true,
        skipAuditAnonymize: true,
      },
    );

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
