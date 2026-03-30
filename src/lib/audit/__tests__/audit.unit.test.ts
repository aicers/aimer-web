import { afterEach, describe, expect, it, vi } from "vitest";

// Mock getAuditPool before importing the module
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock("../../db/client", () => ({
  getAuditPool: () => ({ query: mockQuery }),
}));

// Mock server-only to avoid build-time import error
vi.mock("server-only", () => ({}));

const { auditLog } = await import("../index");
const { withCorrelationId } = await import("../correlation");

describe("auditLog", () => {
  afterEach(() => {
    mockQuery.mockClear();
  });

  it("inserts a row with all fields", async () => {
    await auditLog({
      actorId: "user-1",
      authContext: "general",
      action: "general.auth.sign_in_success",
      targetType: "session",
      targetId: "sid-1",
      details: { foo: "bar" },
      ipAddress: "127.0.0.1",
      sid: "00000000-0000-0000-0000-000000000001",
      customerId: "00000000-0000-0000-0000-000000000002",
      aiceId: "aice.example.com",
    });

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO audit_logs");
    expect(params[0]).toBe("user-1"); // actor_id
    expect(params[1]).toBe("general"); // auth_context
    expect(params[2]).toBe("general.auth.sign_in_success"); // action
    expect(params[3]).toBe("session"); // target_type
    expect(params[4]).toBe("sid-1"); // target_id
    expect(params[5]).toBe('{"foo":"bar"}'); // details
    expect(params[6]).toBe("127.0.0.1"); // ip_address
    expect(params[9]).toBe("aice.example.com"); // aice_id
  });

  it("fills nulls for optional fields", async () => {
    await auditLog({
      actorId: "user-1",
      action: "general.auth.sign_out",
      targetType: "session",
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBeNull(); // auth_context
    expect(params[4]).toBeNull(); // target_id
    expect(params[5]).toBeNull(); // details
    expect(params[6]).toBeNull(); // ip_address
    expect(params[7]).toBeNull(); // sid
    expect(params[8]).toBeNull(); // customer_id
    expect(params[9]).toBeNull(); // aice_id
  });

  it("auto-populates correlationId from AsyncLocalStorage", async () => {
    await withCorrelationId(async () => {
      await auditLog({
        actorId: "user-1",
        action: "general.auth.sign_in_success",
        targetType: "session",
      });
    });

    const [, params] = mockQuery.mock.calls[0];
    // correlation_id should be a UUID string (not null)
    expect(params[10]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("allows explicit correlationId override", async () => {
    const explicitId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await auditLog({
      actorId: "user-1",
      action: "general.auth.sign_in_success",
      targetType: "session",
      correlationId: explicitId,
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[10]).toBe(explicitId);
  });

  it("swallows errors without throwing", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      auditLog({
        actorId: "user-1",
        action: "general.auth.sign_in_success",
        targetType: "session",
      }),
    ).resolves.toBeUndefined();
  });
});
