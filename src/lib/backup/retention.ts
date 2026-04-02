import { parseBackupDirName } from "./naming";
import type { BackupManifest, StorageBackend } from "./storage";

// ---------------------------------------------------------------------------
// Retention purge
// ---------------------------------------------------------------------------

export interface PurgeResult {
  deleted: string[];
  retained: string[];
}

/**
 * Delete backup directories older than the retention window.
 *
 * Backups that contain audit_db data use `auditRetentionDays` (longer).
 * All other backups use `retentionDays`. If a backup contains both
 * audit and non-audit targets, the longer audit window applies.
 *
 * @param storage              - Storage backend to list and delete backups
 * @param retentionDays        - Max age in days for non-audit backups
 * @param auditRetentionDays   - Max age in days for audit backups (defaults to retentionDays)
 * @param now                  - Reference time (defaults to current time)
 */
export async function purgeExpiredBackups(
  storage: StorageBackend,
  retentionDays: number,
  auditRetentionDays: number = retentionDays,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const dirs = await storage.listBackups();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const auditCutoff = new Date(
    now.getTime() - auditRetentionDays * 24 * 60 * 60 * 1000,
  );

  const deleted: string[] = [];
  const retained: string[] = [];

  for (const dir of dirs) {
    const parsed = parseBackupDirName(dir);
    if (!parsed) {
      // Unrecognized directory name — leave it alone
      retained.push(dir);
      continue;
    }

    // Determine effective cutoff by checking if backup has audit data
    let effectiveCutoff = cutoff;
    if (auditRetentionDays !== retentionDays) {
      const manifest = await tryReadManifest(storage, dir);
      if (manifest?.targets.audit_db) {
        effectiveCutoff = auditCutoff;
      }
    }

    if (parsed.date < effectiveCutoff) {
      await storage.deleteBackup(dir);
      deleted.push(dir);
    } else {
      retained.push(dir);
    }
  }

  return { deleted, retained };
}

async function tryReadManifest(
  storage: StorageBackend,
  dirName: string,
): Promise<BackupManifest | null> {
  try {
    const fullPath = storage.resolveBackupDir(dirName);
    return await storage.readManifest(fullPath);
  } catch {
    return null;
  }
}
