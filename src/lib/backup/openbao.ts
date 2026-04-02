import { execFile as execFileCb } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export interface OpenBaoBackupResult {
  durationMs: number;
  sizeBytes: number;
}

/**
 * Backup the OpenBao `file` storage directory to a tar.gz archive.
 *
 * @param baoDataDir - Absolute path to the OpenBao file storage
 *                     (e.g. `/bao/data` from `config.hcl`)
 * @param outputPath - Absolute path for the output archive
 */
export async function backupOpenBao(
  baoDataDir: string,
  outputPath: string,
): Promise<OpenBaoBackupResult> {
  const start = Date.now();

  // tar -czf <output> -C <parent> <basename>
  // Using -C to avoid embedding the full absolute path in the archive.
  const parent = dirname(baoDataDir);
  const base = baoDataDir.split("/").pop() ?? "data";

  try {
    await execFile("tar", ["czf", outputPath, "-C", parent, base]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenBao backup failed: ${message}`);
  }

  const s = await stat(outputPath);
  return { durationMs: Date.now() - start, sizeBytes: s.size };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface OpenBaoRestoreResult {
  durationMs: number;
}

/**
 * Restore an OpenBao file storage directory from a tar.gz archive.
 *
 * **Important**: OpenBao must be stopped before calling this function.
 * The existing data directory is overwritten.
 *
 * @param inputPath  - Absolute path to the tar.gz archive
 * @param baoDataDir - Absolute path where the data should be restored
 */
export async function restoreOpenBao(
  inputPath: string,
  baoDataDir: string,
): Promise<OpenBaoRestoreResult> {
  const start = Date.now();
  const parent = dirname(baoDataDir);

  // Remove existing data directory to avoid stale files from a previous
  // state leaking into the restored snapshot.
  await rm(baoDataDir, { recursive: true, force: true });

  try {
    await execFile("tar", ["xzf", inputPath, "-C", parent]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenBao restore failed: ${message}`);
  }

  return { durationMs: Date.now() - start };
}
