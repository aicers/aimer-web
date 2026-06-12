import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupConfig,
  loadBackupConfig,
  validateForTarget,
} from "../config";

describe("loadBackupConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/auth_db";
    process.env.DATABASE_MIGRATION_URL = "postgres://owner:p@localhost/auth_db";
    process.env.AUDIT_DATABASE_URL = "postgres://u:p@localhost/audit_db";
    process.env.AUDIT_DATABASE_MIGRATION_URL =
      "postgres://owner:p@localhost/audit_db";
    process.env.FEED_DATABASE_URL = "postgres://u:p@localhost/feed_db";
    process.env.FEED_DATABASE_MIGRATION_URL =
      "postgres://owner:p@localhost/feed_db";
    process.env.DATABASE_ADMIN_URL = "postgres://admin:p@localhost/postgres";
    process.env.CUSTOMER_DATABASE_OWNER_URL =
      "postgres://owner:p@localhost/template1";
    process.env.BAO_ADDR = "http://localhost:8200";
    process.env.BAO_TOKEN = "root-token";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("loads defaults when optional vars are absent", () => {
    const cfg = loadBackupConfig();
    expect(cfg.backupDir).toBe("./backups");
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.auditRetentionDays).toBe(365);
  });

  it("reads BACKUP_DIR override", () => {
    process.env.BACKUP_DIR = "/mnt/backups";
    expect(loadBackupConfig().backupDir).toBe("/mnt/backups");
  });

  it("parses integer retention env vars", () => {
    process.env.BACKUP_RETENTION_DAYS = "7";
    process.env.AUDIT_BACKUP_RETENTION_DAYS = "90";
    const cfg = loadBackupConfig();
    expect(cfg.retentionDays).toBe(7);
    expect(cfg.auditRetentionDays).toBe(90);
  });

  it("throws on non-integer retention value", () => {
    process.env.BACKUP_RETENTION_DAYS = "abc";
    expect(() => loadBackupConfig()).toThrow("positive integer");
  });

  it("throws on zero retention value", () => {
    process.env.BACKUP_RETENTION_DAYS = "0";
    expect(() => loadBackupConfig()).toThrow("positive integer");
  });

  it("prefers migration URL over runtime URL for auth", () => {
    const cfg = loadBackupConfig();
    expect(cfg.authDbUrl).toBe("postgres://owner:p@localhost/auth_db");
  });

  it("reads the feed DB URL (migration URL preferred)", () => {
    const cfg = loadBackupConfig();
    expect(cfg.feedDbUrl).toBe("postgres://owner:p@localhost/feed_db");
  });

  it("falls back to runtime URL when migration URL is absent", () => {
    delete process.env.DATABASE_MIGRATION_URL;
    const cfg = loadBackupConfig();
    expect(cfg.authDbUrl).toBe("postgres://u:p@localhost/auth_db");
  });

  it("returns empty string for BAO_ADDR when not set", () => {
    delete process.env.BAO_ADDR;
    expect(loadBackupConfig().baoAddr).toBe("");
  });

  it("returns empty string for BAO_TOKEN when not set", () => {
    delete process.env.BAO_TOKEN;
    expect(loadBackupConfig().baoToken).toBe("");
  });

  it("does not throw when only auth-related vars are set", () => {
    delete process.env.CUSTOMER_DATABASE_OWNER_URL;
    delete process.env.BAO_ADDR;
    delete process.env.BAO_TOKEN;
    const cfg = loadBackupConfig();
    expect(cfg.authDbUrl).toBeTruthy();
    expect(cfg.customerOwnerTemplateUrl).toBe("");
  });
});

describe("validateForTarget", () => {
  function makeConfig(overrides?: Partial<BackupConfig>): BackupConfig {
    return {
      backupDir: "./backups",
      retentionDays: 30,
      auditRetentionDays: 365,
      authDbUrl: "postgres://u:p@localhost/auth_db",
      auditDbUrl: "postgres://u:p@localhost/audit_db",
      feedDbUrl: "postgres://u:p@localhost/feed_db",
      adminDbUrl: "postgres://admin:p@localhost/postgres",
      customerOwnerTemplateUrl: "postgres://owner:p@localhost/template1",
      baoDataDir: "/bao/data",
      baoAddr: "http://localhost:8200",
      baoToken: "root-token",
      ...overrides,
    };
  }

  it("passes for a complete config with target=all", () => {
    expect(() => validateForTarget(makeConfig(), "all")).not.toThrow();
  });

  it("throws when authDbUrl is empty for auth target", () => {
    expect(() =>
      validateForTarget(makeConfig({ authDbUrl: "" }), "auth"),
    ).toThrow("DATABASE_MIGRATION_URL");
  });

  it("throws when auditDbUrl is empty for audit target", () => {
    expect(() =>
      validateForTarget(makeConfig({ auditDbUrl: "" }), "audit"),
    ).toThrow("AUDIT_DATABASE");
  });

  it("throws when feedDbUrl is empty for feed target", () => {
    expect(() =>
      validateForTarget(makeConfig({ feedDbUrl: "" }), "feed"),
    ).toThrow("FEED_DATABASE");
  });

  it("requires the feed URL when target is all", () => {
    expect(() =>
      validateForTarget(makeConfig({ feedDbUrl: "" }), "all"),
    ).toThrow("FEED_DATABASE");
  });

  it("throws when customerOwnerTemplateUrl is empty for customers target", () => {
    expect(() =>
      validateForTarget(
        makeConfig({ customerOwnerTemplateUrl: "" }),
        "customers",
      ),
    ).toThrow("CUSTOMER_DATABASE_OWNER_URL");
  });

  it("throws when baoDataDir is empty for openbao target", () => {
    expect(() =>
      validateForTarget(makeConfig({ baoDataDir: "" }), "openbao"),
    ).toThrow("BAO_DATA_DIR");
  });

  it("does not check openbao fields when target is auth", () => {
    expect(() =>
      validateForTarget(makeConfig({ baoDataDir: "" }), "auth"),
    ).not.toThrow();
  });
});
