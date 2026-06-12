// ---------------------------------------------------------------------------
// Backup file and directory naming conventions
// ---------------------------------------------------------------------------

/**
 * Generate a backup directory name from a timestamp and optional label.
 * Format: `YYYY-MM-DDTHH-MM-SSZ` or `YYYY-MM-DDTHH-MM-SSZ_<label>`
 */
export function backupDirName(date: Date, label?: string): string {
  const ts = date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
  if (label) {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
    return `${ts}_${safe}`;
  }
  return ts;
}

/**
 * Parse a backup directory name back to a Date and optional label.
 * Returns null if the name doesn't match the expected format.
 */
export function parseBackupDirName(
  dirName: string,
): { date: Date; label?: string } | null {
  const match = dirName.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:_(.+))?$/,
  );
  if (!match) return null;

  const isoString = match[1].replace(/(\d{2})-(\d{2})-(\d{2})Z$/, "$1:$2:$3Z");
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;

  return { date, label: match[2] };
}

/** Filename for an auth_db / audit_db / feed_db dump. */
export function dbDumpFileName(target: "auth" | "audit" | "feed"): string {
  return `${target}_db.dump`;
}

/** Filename for a customer database dump (inside `customers/` subdir). */
export function customerDumpFileName(customerId: string): string {
  return `customer_${customerId.replace(/-/g, "")}.dump`;
}

/** Filename for the OpenBao storage archive (inside `openbao/` subdir). */
export function openbaoDumpFileName(): string {
  return "bao-data.tar.gz";
}
