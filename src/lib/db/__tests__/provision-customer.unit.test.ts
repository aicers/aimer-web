import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuditLog = vi.fn();
vi.mock("../../audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

vi.mock("../../crypto/transit", () => ({
  getTransitConfig: () => ({ addr: "http://mock:8200", token: "mock" }),
  generateDataKey: vi.fn().mockResolvedValue({
    plaintext: Buffer.alloc(32, 0xab),
    wrappedDek: "vault:v1:mock-dek",
  }),
}));

const { provisionCustomerDb } = await import("../provision-customer");

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
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

function mockPoolPrototype() {
  vi.spyOn(Pool.prototype, "query").mockImplementation(
    async () =>
      ({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] }) as never,
  );
  vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);
}

function makeSuccessDeps() {
  return {
    adminUrl: "postgresql://localhost/test",
    ownerTemplateUrl: "postgresql://localhost/test",
    migrationsDir: "/tmp/nonexistent",
    generateDek: vi.fn().mockResolvedValue({ wrappedDek: "vault:v1:test" }),
  };
}

function makeFailDeps() {
  return {
    adminUrl: "postgresql://localhost/test",
    ownerTemplateUrl: "postgresql://localhost/test",
    migrationsDir: "/tmp/nonexistent",
    generateDek: vi.fn().mockRejectedValue(new Error("Transit down")),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionCustomerDb audit emissions", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("emits customer_db.provisioned on success with actorContext", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype();

    const migrateModule = await import("../migrate");
    vi.spyOn(migrateModule, "runMigrations").mockResolvedValue(undefined);

    const status = await provisionCustomerDb(
      authPool as never,
      CUSTOMER_ID,
      { actorContext: ACTOR_CONTEXT },
      makeSuccessDeps(),
    );

    expect(status).toBe("active");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        authContext: "admin",
        action: "customer_db.provisioned",
        targetType: "customer_db",
        targetId: CUSTOMER_ID,
        customerId: CUSTOMER_ID,
        details: expect.objectContaining({ outcome: "active" }),
      }),
    );
  });

  it("emits customer_db.provision_retried on success with isRetry=true", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype();

    const migrateModule = await import("../migrate");
    vi.spyOn(migrateModule, "runMigrations").mockResolvedValue(undefined);

    const status = await provisionCustomerDb(
      authPool as never,
      CUSTOMER_ID,
      { actorContext: ACTOR_CONTEXT, isRetry: true },
      makeSuccessDeps(),
    );

    expect(status).toBe("active");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_db.provision_retried",
        details: expect.objectContaining({ outcome: "active" }),
      }),
    );
  });

  it("emits customer_db.provision_failed on failure with actorContext", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype();

    const status = await provisionCustomerDb(
      authPool as never,
      CUSTOMER_ID,
      { actorContext: ACTOR_CONTEXT },
      makeFailDeps(),
    );

    expect(status).toBe("failed");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_db.provision_failed",
        targetType: "customer_db",
        targetId: CUSTOMER_ID,
        details: expect.objectContaining({
          outcome: "failed",
          error: "Transit down",
        }),
      }),
    );
  });

  it("emits customer_db.provision_retried on failure with isRetry=true", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype();

    const status = await provisionCustomerDb(
      authPool as never,
      CUSTOMER_ID,
      { actorContext: ACTOR_CONTEXT, isRetry: true },
      makeFailDeps(),
    );

    expect(status).toBe("failed");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_db.provision_retried",
        details: expect.objectContaining({ outcome: "failed" }),
      }),
    );
  });

  it("does not emit audit events when actorContext is omitted", async () => {
    const authPool = makeAuthPool();
    mockPoolPrototype();

    await provisionCustomerDb(
      authPool as never,
      CUSTOMER_ID,
      undefined,
      makeFailDeps(),
    );

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
