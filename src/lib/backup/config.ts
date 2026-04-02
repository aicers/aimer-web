// ---------------------------------------------------------------------------
// Backup configuration — parsed from environment variables
// ---------------------------------------------------------------------------

export interface BackupConfig {
  backupDir: string;
  retentionDays: number;
  auditRetentionDays: number;
  authDbUrl: string;
  auditDbUrl: string;
  adminDbUrl: string;
  customerOwnerTemplateUrl: string;
  baoDataDir: string;
  baoAddr: string;
  baoToken: string;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Load the full backup configuration from environment variables.
 * Used by the backup/restore CLIs.
 */
export function loadBackupConfig(): BackupConfig {
  return {
    backupDir: optionalEnv("BACKUP_DIR", "./backups"),
    retentionDays: intEnv("BACKUP_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    auditRetentionDays: intEnv(
      "AUDIT_BACKUP_RETENTION_DAYS",
      DEFAULT_AUDIT_RETENTION_DAYS,
    ),
    authDbUrl:
      process.env.DATABASE_MIGRATION_URL ?? optionalEnv("DATABASE_URL", ""),
    auditDbUrl:
      process.env.AUDIT_DATABASE_MIGRATION_URL ??
      optionalEnv("AUDIT_DATABASE_URL", ""),
    adminDbUrl:
      process.env.DATABASE_ADMIN_URL ?? optionalEnv("DATABASE_URL", ""),
    customerOwnerTemplateUrl: optionalEnv("CUSTOMER_DATABASE_OWNER_URL", ""),
    baoDataDir: optionalEnv("BAO_DATA_DIR", ""),
    baoAddr: optionalEnv("BAO_ADDR", ""),
    baoToken: optionalEnv("BAO_TOKEN", ""),
  };
}

export type BackupTarget = "auth" | "audit" | "customers" | "openbao";

/**
 * Validate that the loaded config has the fields needed for a given target.
 * Throws with a descriptive message on the first missing requirement.
 */
export function validateForTarget(
  config: BackupConfig,
  target: BackupTarget | "all",
): void {
  const targets: BackupTarget[] =
    target === "all" ? ["auth", "audit", "customers", "openbao"] : [target];

  for (const t of targets) {
    switch (t) {
      case "auth":
        if (!config.authDbUrl)
          throw new Error(
            "DATABASE_MIGRATION_URL or DATABASE_URL is required for auth backup",
          );
        break;
      case "audit":
        if (!config.auditDbUrl)
          throw new Error(
            "AUDIT_DATABASE_MIGRATION_URL or AUDIT_DATABASE_URL is required for audit backup",
          );
        break;
      case "customers":
        if (!config.customerOwnerTemplateUrl)
          throw new Error(
            "CUSTOMER_DATABASE_OWNER_URL is required for customer backup",
          );
        if (!config.adminDbUrl)
          throw new Error(
            "DATABASE_ADMIN_URL or DATABASE_URL is required for customer backup",
          );
        break;
      case "openbao":
        if (!config.baoDataDir)
          throw new Error("BAO_DATA_DIR is required for OpenBao backup");
        break;
    }
  }
}
