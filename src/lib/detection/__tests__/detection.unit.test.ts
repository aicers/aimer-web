import { afterEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock("../../db/client", () => ({
  getAuditPool: () => ({ query: mockQuery }),
}));

const mockGetCorrelationId = vi.fn().mockReturnValue(undefined);
vi.mock("../../audit/correlation", () => ({
  getCorrelationId: () => mockGetCorrelationId(),
}));

vi.mock("server-only", () => ({}));

const { insertAlert, emitSevereAlert } = await import("../index");

describe("insertAlert", () => {
  afterEach(() => {
    mockQuery.mockClear();
    mockGetCorrelationId.mockReturnValue(undefined);
  });

  it("inserts a row with all fields", async () => {
    await insertAlert({
      indicator: "consecutive_sign_in_denials",
      actorId: "user-1",
      ipAddress: "10.0.0.1",
      summary: { count: 5 },
      auditLogIds: [1, 2, 3],
      correlationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO suspicious_activity_alerts");
    expect(params[0]).toBe("consecutive_sign_in_denials"); // indicator
    expect(params[1]).toBe("warning"); // severity (auto from severityOf)
    expect(params[2]).toBe("user-1"); // actor_id
    expect(params[3]).toBe("10.0.0.1"); // ip_address
    expect(params[4]).toBe('{"count":5}'); // summary
    expect(params[5]).toEqual([1, 2, 3]); // audit_log_ids
    expect(params[6]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("fills nulls for optional fields", async () => {
    await insertAlert({
      indicator: "bridge_abuse",
      summary: { aiceId: "test" },
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBeNull(); // actor_id
    expect(params[3]).toBeNull(); // ip_address
    expect(params[5]).toEqual([]); // audit_log_ids
    expect(params[6]).toBeNull(); // correlation_id
  });

  it("falls back to AsyncLocalStorage correlation ID when not explicit", async () => {
    mockGetCorrelationId.mockReturnValue("from-async-local-storage");

    await insertAlert({
      indicator: "bridge_abuse",
      summary: { aiceId: "test" },
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBe("from-async-local-storage");
  });

  it("prefers explicit correlationId over AsyncLocalStorage", async () => {
    mockGetCorrelationId.mockReturnValue("from-async-local-storage");

    await insertAlert({
      indicator: "bridge_abuse",
      summary: { aiceId: "test" },
      correlationId: "explicit-id",
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBe("explicit-id");
  });

  it("auto-assigns severity from indicator type", async () => {
    // severe indicator
    await insertAlert({
      indicator: "suspended_account_sign_in",
      summary: { reason: "status_suspended" },
    });

    const [, severeParams] = mockQuery.mock.calls[0];
    expect(severeParams[1]).toBe("severe");

    mockQuery.mockClear();

    // warning indicator
    await insertAlert({
      indicator: "bridge_abuse",
      summary: { aiceId: "test" },
    });

    const [, warningParams] = mockQuery.mock.calls[0];
    expect(warningParams[1]).toBe("warning");
  });

  it("allows explicit severity override", async () => {
    await insertAlert({
      indicator: "bridge_abuse",
      severity: "severe",
      summary: { aiceId: "test" },
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe("severe");
  });

  it("swallows errors without throwing", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      insertAlert({
        indicator: "bridge_abuse",
        summary: { aiceId: "test" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("emitSevereAlert", () => {
  afterEach(() => {
    mockQuery.mockClear();
  });

  it("always inserts with severity=severe", async () => {
    await emitSevereAlert({
      indicator: "bridge_abuse", // normally "warning"
      summary: { aiceId: "test" },
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe("severe");
  });

  it("passes all params through to insertAlert", async () => {
    await emitSevereAlert({
      indicator: "suspended_account_sign_in",
      actorId: "actor-1",
      ipAddress: "1.2.3.4",
      summary: { reason: "status_suspended", authContext: "admin" },
      auditLogIds: [42],
      correlationId: "11111111-2222-3333-4444-555555555555",
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe("suspended_account_sign_in");
    expect(params[2]).toBe("actor-1");
    expect(params[3]).toBe("1.2.3.4");
    expect(params[5]).toEqual([42]);
    expect(params[6]).toBe("11111111-2222-3333-4444-555555555555");
  });
});
