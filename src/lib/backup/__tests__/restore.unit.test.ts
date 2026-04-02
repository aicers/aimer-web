import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupConfig } from "../config";
import type { BackupManifest } from "../storage";

vi.mock("server-only", () => ({}));

vi.mock("../dump", () => ({
  pgRestore: vi.fn().mockResolvedValue({ durationMs: 50 }),
}));

vi.mock("../openbao", () => ({
  restoreOpenBao: vi.fn().mockResolvedValue({ durationMs: 30 }),
}));

vi.mock("../post-restore", () => ({
  runPostRestoreCleanup: vi.fn().mockResolvedValue({
    sessionsRevoked: 5,
    pendingConnectionsDeleted: 2,
    stagedCustomersDeleted: 1,
    stagedPayloadsDeleted: 1,
  }),
}));

vi.mock("../../db/migrate", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

const mockPoolQuery = vi.fn();
const mockPoolEnd = vi.fn();
const mockPoolConnect = vi.fn();

class MockPool {
  query = mockPoolQuery;
  end = mockPoolEnd;
  connect = mockPoolConnect;
  on = vi.fn();
}

vi.mock("pg", () => ({
  Pool: MockPool,
}));

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

function makeManifest(overrides?: Partial<BackupManifest>): BackupManifest {
  return {
    version: 1,
    createdAt: "2026-04-02T10:00:00.000Z",
    label: null,
    targets: {
      auth_db: { file: "auth_db.dump", sizeBytes: 4096, durationMs: 100 },
      audit_db: { file: "audit_db.dump", sizeBytes: 2048, durationMs: 80 },
      openbao: {
        file: "openbao/bao-data.tar.gz",
        sizeBytes: 1024,
        durationMs: 50,
      },
      customers: [
        {
          customerId: "cust-1",
          file: "customers/customer_cust1.dump",
          sizeBytes: 512,
          durationMs: 30,
        },
      ],
    },
    skipped: [],
    errors: [],
    ...overrides,
  };
}

describe("restoreAuth", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls pgRestore with clean and noOwner", async () => {
    const { pgRestore } = await import("../dump");
    const { restoreAuth } = await import("../restore");

    await restoreAuth("/backups/auth_db.dump", makeConfig());

    expect(pgRestore).toHaveBeenCalledWith({
      connectionUrl: "postgres://u:p@localhost/auth_db",
      inputPath: "/backups/auth_db.dump",
      clean: true,
      noOwner: true,
    });
  });
});

describe("restoreAudit", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls pgRestore for audit_db", async () => {
    const { pgRestore } = await import("../dump");
    const { restoreAudit } = await import("../restore");

    await restoreAudit("/backups/audit_db.dump", makeConfig());

    expect(pgRestore).toHaveBeenCalledWith({
      connectionUrl: "postgres://u:p@localhost/audit_db",
      inputPath: "/backups/audit_db.dump",
      clean: true,
      noOwner: true,
    });
  });
});

describe("restoreCustomer", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates database when it does not exist", async () => {
    // pg_database check returns empty
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT 1 FROM pg_database
      .mockResolvedValueOnce({}); // CREATE DATABASE

    const { restoreCustomer } = await import("../restore");
    const adminPool = { query: mockPoolQuery, end: mockPoolEnd } as never;

    await restoreCustomer(
      "/backups/customer.dump",
      "abc-123",
      makeConfig(),
      adminPool,
    );

    // Should have called CREATE DATABASE
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const createCall = mockPoolQuery.mock.calls[1][0] as string;
    expect(createCall).toContain("CREATE DATABASE");
  });

  it("skips CREATE when database already exists", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ "?column?": 1 }],
    });

    const { pgRestore } = await import("../dump");
    const { restoreCustomer } = await import("../restore");
    const adminPool = { query: mockPoolQuery, end: mockPoolEnd } as never;

    await restoreCustomer(
      "/backups/customer.dump",
      "abc-123",
      makeConfig(),
      adminPool,
    );

    // Only 1 query (the existence check), no CREATE
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(pgRestore).toHaveBeenCalled();
  });
});

describe("restoreOpenBaoStorage", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls restoreOpenBao with correct paths", async () => {
    const { restoreOpenBao } = await import("../openbao");
    const { restoreOpenBaoStorage } = await import("../restore");

    await restoreOpenBaoStorage(
      "/backups/bao-data.tar.gz",
      makeConfig({ baoDataDir: "/opt/bao/data" }),
    );

    expect(restoreOpenBao).toHaveBeenCalledWith(
      "/backups/bao-data.tar.gz",
      "/opt/bao/data",
    );
  });
});

describe("restoreFullFromManifest", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset();
    // Default: DB exists for customer restore
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores all targets in correct order", async () => {
    const { pgRestore } = await import("../dump");
    const { restoreOpenBao } = await import("../openbao");
    const { runPostRestoreCleanup } = await import("../post-restore");
    const { runMigrations } = await import("../../db/migrate");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(pgRestore).mockClear();
    vi.mocked(restoreOpenBao).mockClear();
    vi.mocked(runPostRestoreCleanup).mockClear();
    vi.mocked(runMigrations).mockClear();

    const result = await restoreFullFromManifest(
      makeManifest(),
      "/backups/2026-04-02",
      makeConfig(),
      false,
      false,
    );

    // OpenBao restored
    expect(restoreOpenBao).toHaveBeenCalledOnce();

    // 3 pgRestore calls: auth, audit, customer
    expect(pgRestore).toHaveBeenCalledTimes(3);

    // Post-restore cleanup ran
    expect(runPostRestoreCleanup).toHaveBeenCalledOnce();

    // Migrations ran for auth and audit
    expect(runMigrations).toHaveBeenCalledTimes(2);

    // No errors
    expect(result.errors).toEqual([]);
  });

  it("skips missing targets in manifest", async () => {
    const { pgRestore } = await import("../dump");
    const { restoreOpenBao } = await import("../openbao");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(pgRestore).mockClear();
    vi.mocked(restoreOpenBao).mockClear();

    // Manifest with only auth_db
    const manifest = makeManifest({
      targets: {
        auth_db: { file: "auth_db.dump", sizeBytes: 4096, durationMs: 100 },
      },
    });

    await restoreFullFromManifest(
      manifest,
      "/backups/2026-04-02",
      makeConfig(),
      false,
      false,
    );

    // Only auth restored, no openbao/audit/customer
    expect(restoreOpenBao).not.toHaveBeenCalled();
    expect(pgRestore).toHaveBeenCalledTimes(1);
  });

  it("skips post-cleanup when skipPostCleanup is true", async () => {
    const { runPostRestoreCleanup } = await import("../post-restore");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(runPostRestoreCleanup).mockClear();

    await restoreFullFromManifest(
      makeManifest(),
      "/backups/2026-04-02",
      makeConfig(),
      true, // skipPostCleanup
      false,
    );

    expect(runPostRestoreCleanup).not.toHaveBeenCalled();
  });

  it("skips migrations when skipMigrations is true", async () => {
    const { runMigrations } = await import("../../db/migrate");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(runMigrations).mockClear();

    await restoreFullFromManifest(
      makeManifest(),
      "/backups/2026-04-02",
      makeConfig(),
      false,
      true, // skipMigrations
    );

    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("skips post-cleanup when auth_db not in manifest", async () => {
    const { runPostRestoreCleanup } = await import("../post-restore");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(runPostRestoreCleanup).mockClear();

    const manifest = makeManifest({
      targets: {
        audit_db: { file: "audit_db.dump", sizeBytes: 2048, durationMs: 80 },
      },
    });

    await restoreFullFromManifest(
      manifest,
      "/backups/2026-04-02",
      makeConfig(),
      false, // skipPostCleanup = false, but no auth_db
      false,
    );

    // Should not run cleanup because auth_db was not restored
    expect(runPostRestoreCleanup).not.toHaveBeenCalled();
  });

  it("continues on customer restore failure", async () => {
    const { pgRestore } = await import("../dump");
    const { restoreFullFromManifest } = await import("../restore");

    vi.mocked(pgRestore).mockClear();
    // Fail on the 3rd call (customer restore)
    vi.mocked(pgRestore)
      .mockResolvedValueOnce({ durationMs: 50 }) // auth
      .mockResolvedValueOnce({ durationMs: 50 }) // audit
      .mockRejectedValueOnce(new Error("disk full")); // customer

    const manifest = makeManifest();

    // Should not throw — customer failures are caught and returned
    const result = await restoreFullFromManifest(
      manifest,
      "/backups/2026-04-02",
      makeConfig(),
      true,
      true,
    );

    // All 3 pgRestore calls were attempted
    expect(pgRestore).toHaveBeenCalledTimes(3);

    // Error is recorded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].target).toBe("customer-cust-1");
    expect(result.errors[0].error).toContain("disk full");
  });
});
