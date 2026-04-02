import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../dump", () => ({
  pgRestore: vi.fn().mockResolvedValue({ durationMs: 50 }),
}));

vi.mock("../../db/migrate", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../crypto/transit", () => ({
  getTransitConfig: vi.fn().mockReturnValue({
    addr: "http://localhost:8200",
    token: "root-token",
  }),
  decryptDataKey: vi.fn().mockResolvedValue(Buffer.from("decrypted-key")),
}));

const mockAdminQuery = vi.fn();
const mockAdminEnd = vi.fn();
const mockTempQuery = vi.fn();
const mockTempEnd = vi.fn();
const mockTempOn = vi.fn();

let poolCallCount = 0;

class MockPool {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;

  constructor() {
    // First Pool = admin, second Pool = temp (or auth for DEK tests)
    if (poolCallCount % 2 === 0) {
      this.query = mockAdminQuery;
      this.end = mockAdminEnd;
      this.on = vi.fn();
    } else {
      this.query = mockTempQuery;
      this.end = mockTempEnd;
      this.on = mockTempOn;
    }
    poolCallCount++;
  }
}

vi.mock("pg", () => ({
  Pool: MockPool,
}));

describe("verifyDbRestore", () => {
  beforeEach(() => {
    poolCallCount = 0;
    mockAdminQuery.mockReset();
    mockAdminEnd.mockReset();
    mockTempQuery.mockReset();
    mockTempEnd.mockReset();
    mockTempOn.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: admin queries succeed
    mockAdminQuery.mockResolvedValue({ rows: [] });
    // Default: temp query returns row count
    mockTempQuery.mockResolvedValue({ rows: [{ count: "42" }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true on successful verification", async () => {
    const { verifyDbRestore } = await import("../verify");

    const result = await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(result).toBe(true);
  });

  it("creates and drops a temporary database", async () => {
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    // First call: CREATE DATABASE
    const createCall = mockAdminQuery.mock.calls[0][0] as string;
    expect(createCall).toContain("CREATE DATABASE");
    expect(createCall).toContain("verify_auth_db_");

    // Should terminate backends and drop
    const terminateCall = mockAdminQuery.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("pg_terminate_backend"),
    );
    expect(terminateCall).toBeDefined();

    const dropCall = mockAdminQuery.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("DROP DATABASE"),
    );
    expect(dropCall).toBeDefined();
  });

  it("calls pgRestore with noOwner on temp database", async () => {
    const { pgRestore } = await import("../dump");
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(pgRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/backups/auth_db.dump",
        noOwner: true,
      }),
    );
  });

  it("runs migrations on temp database", async () => {
    const { runMigrations } = await import("../../db/migrate");
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(runMigrations).toHaveBeenCalledWith(
      expect.anything(),
      "/migrations/auth",
      9100,
    );
  });

  it("queries the verify table for row count", async () => {
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(mockTempQuery).toHaveBeenCalledWith(
      "SELECT count(*) FROM _migrations",
    );
  });

  it("returns false and cleans up on restore failure", async () => {
    const { pgRestore } = await import("../dump");
    vi.mocked(pgRestore).mockRejectedValueOnce(new Error("corrupt dump"));

    const { verifyDbRestore } = await import("../verify");

    const result = await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(result).toBe(false);
    // Should still attempt DROP
    const dropCall = mockAdminQuery.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("DROP DATABASE"),
    );
    expect(dropCall).toBeDefined();
  });

  it("returns false on migration failure", async () => {
    const { runMigrations } = await import("../../db/migrate");
    vi.mocked(runMigrations).mockRejectedValueOnce(
      new Error("migration failed"),
    );

    const { verifyDbRestore } = await import("../verify");

    const result = await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(result).toBe(false);
  });

  it("always closes admin pool in finally", async () => {
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "auth_db",
      "/backups/auth_db.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/auth",
      9100,
      "_migrations",
    );

    expect(mockAdminEnd).toHaveBeenCalled();
  });

  it("sanitizes hyphens from label in temp DB name", async () => {
    const { verifyDbRestore } = await import("../verify");

    await verifyDbRestore(
      "customer_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "/backups/customer.dump",
      "postgres://admin:p@localhost/postgres",
      "/migrations/customer",
      9200,
      "_migrations",
    );

    const createCall = mockAdminQuery.mock.calls[0][0] as string;
    expect(createCall).toContain("CREATE DATABASE");
    // Must not contain hyphens — they're invalid in unquoted PG identifiers
    const dbName = createCall.replace("CREATE DATABASE ", "");
    expect(dbName).not.toContain("-");
    expect(dbName).toContain(
      "verify_customer_a1b2c3d4_e5f6_7890_abcd_ef1234567890_",
    );
  });
});

describe("verifyCustomerDek", () => {
  beforeEach(() => {
    poolCallCount = 0;
    mockAdminQuery.mockReset();
    mockAdminEnd.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'pass' when DEK unwrap succeeds", async () => {
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ wrapped_dek: Buffer.from("wrapped") }],
    });

    const { verifyCustomerDek } = await import("../verify");

    const result = await verifyCustomerDek(
      "cust-123",
      "postgres://u:p@localhost/auth_db",
    );

    expect(result).toBe("pass");
  });

  it("calls decryptDataKey with correct key name", async () => {
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ wrapped_dek: Buffer.from("wrapped") }],
    });

    const { decryptDataKey } = await import("../../crypto/transit");
    const { verifyCustomerDek } = await import("../verify");

    await verifyCustomerDek("cust-123", "postgres://u:p@localhost/auth_db");

    expect(decryptDataKey).toHaveBeenCalledWith(
      expect.anything(),
      "customer-cust-123",
      Buffer.from("wrapped"),
    );
  });

  it("returns 'warn' when customer has no wrapped DEK", async () => {
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ wrapped_dek: null }],
    });

    const { verifyCustomerDek } = await import("../verify");

    const result = await verifyCustomerDek(
      "cust-no-dek",
      "postgres://u:p@localhost/auth_db",
    );

    expect(result).toBe("warn");
  });

  it("returns 'warn' when customer not found", async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [] });

    const { verifyCustomerDek } = await import("../verify");

    const result = await verifyCustomerDek(
      "nonexistent",
      "postgres://u:p@localhost/auth_db",
    );

    expect(result).toBe("warn");
  });

  it("returns 'fail' when DEK unwrap fails", async () => {
    mockAdminQuery.mockResolvedValueOnce({
      rows: [{ wrapped_dek: Buffer.from("wrapped") }],
    });

    const { decryptDataKey } = await import("../../crypto/transit");
    vi.mocked(decryptDataKey).mockRejectedValueOnce(
      new Error("key not found in transit"),
    );

    const { verifyCustomerDek } = await import("../verify");

    const result = await verifyCustomerDek(
      "cust-bad",
      "postgres://u:p@localhost/auth_db",
    );

    expect(result).toBe("fail");
  });

  it("always closes auth pool", async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [] });

    const { verifyCustomerDek } = await import("../verify");

    await verifyCustomerDek("cust-123", "postgres://u:p@localhost/auth_db");

    expect(mockAdminEnd).toHaveBeenCalled();
  });
});
