import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupConfig } from "../config";
import type { StorageBackend } from "../storage";

vi.mock("server-only", () => ({}));

// Mock external deps before importing the module under test
vi.mock("../dump", () => ({
  pgDump: vi.fn().mockResolvedValue({ durationMs: 100, sizeBytes: 4096 }),
}));

vi.mock("../openbao", () => ({
  backupOpenBao: vi.fn().mockResolvedValue({ durationMs: 50, sizeBytes: 2048 }),
}));

vi.mock("../retention", () => ({
  purgeExpiredBackups: vi.fn().mockResolvedValue({ deleted: [], retained: [] }),
}));

vi.mock("pg", () => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return {
    Pool: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      end: mockEnd,
    })),
    __mockQuery: mockQuery,
    __mockEnd: mockEnd,
  };
});

function makeConfig(overrides?: Partial<BackupConfig>): BackupConfig {
  return {
    backupDir: "/tmp/backups",
    retentionDays: 30,
    auditRetentionDays: 365,
    authDbUrl: "postgres://u:p@localhost/auth_db",
    auditDbUrl: "postgres://u:p@localhost/audit_db",
    adminDbUrl: "postgres://admin:p@localhost/postgres",
    customerOwnerTemplateUrl: "postgres://owner:p@localhost/template1",
    baoDataDir: "/bao/data",
    baoAddr: "http://localhost:8200",
    baoToken: "root-token",
    ...overrides,
  };
}

function makeMockStorage(): StorageBackend & {
  manifests: Map<string, unknown>;
} {
  const manifests = new Map<string, unknown>();
  return {
    manifests,
    initBackupDir: vi.fn().mockImplementation(async (dirName: string) => {
      return `/tmp/backups/${dirName}`;
    }),
    resolveBackupDir: vi
      .fn()
      .mockImplementation((dir: string) => `/tmp/backups/${dir}`),
    getAbsolutePath: vi
      .fn()
      .mockImplementation((dir: string, rel: string) => `${dir}/${rel}`),
    writeManifest: vi
      .fn()
      .mockImplementation(async (dir: string, m: unknown) => {
        manifests.set(dir, m);
      }),
    readManifest: vi.fn(),
    listBackups: vi.fn().mockResolvedValue([]),
    deleteBackup: vi.fn(),
  };
}

describe("runBackup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates manifest with auth_db target", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();
    const config = makeConfig();

    const result = await runBackup({
      config,
      storage,
      targets: ["auth"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.version).toBe(1);
    expect(result.manifest.targets.auth_db).toBeDefined();
    expect(result.manifest.targets.auth_db?.file).toBe("auth_db.dump");
    expect(result.manifest.targets.auth_db?.sizeBytes).toBe(4096);
    expect(result.manifest.errors).toEqual([]);
  });

  it("creates manifest with audit_db target", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["audit"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.targets.audit_db).toBeDefined();
    expect(result.manifest.targets.audit_db?.file).toBe("audit_db.dump");
  });

  it("creates manifest with openbao target", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["openbao"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.targets.openbao).toBeDefined();
    expect(result.manifest.targets.openbao?.file).toBe(
      "openbao/bao-data.tar.gz",
    );
  });

  it("handles multiple targets", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth", "audit", "openbao"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.targets.auth_db).toBeDefined();
    expect(result.manifest.targets.audit_db).toBeDefined();
    expect(result.manifest.targets.openbao).toBeDefined();
  });

  it("records label in manifest", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth"],
      label: "pre-delete-abc",
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.label).toBe("pre-delete-abc");
  });

  it("records errors in manifest when target fails", async () => {
    const { pgDump } = await import("../dump");
    vi.mocked(pgDump).mockRejectedValueOnce(new Error("connection refused"));

    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(result.manifest.errors).toHaveLength(1);
    expect(result.manifest.errors[0].target).toBe("auth");
    expect(result.manifest.errors[0].error).toContain("connection refused");
    expect(result.manifest.targets.auth_db).toBeUndefined();
  });

  it("writes manifest to storage", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(storage.writeManifest).toHaveBeenCalledOnce();
  });

  it("runs retention purge after backup", async () => {
    const { purgeExpiredBackups } = await import("../retention");
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();

    await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth"],
      now: new Date("2026-04-02T10:00:00Z"),
    });

    expect(purgeExpiredBackups).toHaveBeenCalledWith(storage, 30, 365);
  });

  it("sets createdAt from the provided now date", async () => {
    const { runBackup } = await import("../backup");
    const storage = makeMockStorage();
    const now = new Date("2026-04-02T10:00:00.000Z");

    const result = await runBackup({
      config: makeConfig(),
      storage,
      targets: ["auth"],
      now,
    });

    expect(result.manifest.createdAt).toBe("2026-04-02T10:00:00.000Z");
  });
});

describe("backupCustomerDbs", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backs up active customers", async () => {
    const { backupCustomerDbs } = await import("../backup");
    const storage = makeMockStorage();
    const config = makeConfig();

    const mockAuthPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "cust-1", database_status: "active", status: "active" }],
      }),
    };
    const mockAdminPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    };

    const result = await backupCustomerDbs({
      config,
      backupDir: "/tmp/backups/2026-04-02",
      storage,
      authPool: mockAuthPool as never,
      adminPool: mockAdminPool as never,
    });

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].customerId).toBe("cust-1");
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips customers whose database does not exist", async () => {
    const { backupCustomerDbs } = await import("../backup");
    const storage = makeMockStorage();
    const config = makeConfig();

    const mockAuthPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "cust-1", database_status: "failed", status: "active" }],
      }),
    };
    const mockAdminPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }), // DB doesn't exist
    };

    const result = await backupCustomerDbs({
      config,
      backupDir: "/tmp/backups/2026-04-02",
      storage,
      authPool: mockAuthPool as never,
      adminPool: mockAdminPool as never,
    });

    expect(result.customers).toEqual([]);
    expect(result.skipped).toEqual(["customer-cust-1"]);
  });

  it("throws when single customer is not found", async () => {
    const { backupCustomerDbs } = await import("../backup");
    const storage = makeMockStorage();
    const config = makeConfig();

    const mockAuthPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const mockAdminPool = { query: vi.fn() };

    await expect(
      backupCustomerDbs({
        config,
        backupDir: "/tmp/backups/2026-04-02",
        storage,
        singleCustomerId: "nonexistent",
        authPool: mockAuthPool as never,
        adminPool: mockAdminPool as never,
      }),
    ).rejects.toThrow("Customer nonexistent not found");
  });

  it("records per-customer errors without failing the batch", async () => {
    const { pgDump } = await import("../dump");
    vi.mocked(pgDump).mockRejectedValueOnce(new Error("disk full"));

    const { backupCustomerDbs } = await import("../backup");
    const storage = makeMockStorage();
    const config = makeConfig();

    const mockAuthPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "cust-1", database_status: "active", status: "active" }],
      }),
    };
    const mockAdminPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    };

    const result = await backupCustomerDbs({
      config,
      backupDir: "/tmp/backups/2026-04-02",
      storage,
      authPool: mockAuthPool as never,
      adminPool: mockAdminPool as never,
    });

    expect(result.customers).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].target).toBe("customer-cust-1");
    expect(result.errors[0].error).toContain("disk full");
  });
});
