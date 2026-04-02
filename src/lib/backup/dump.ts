import { execFile as execFileCb } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// pg_dump
// ---------------------------------------------------------------------------

export interface DumpOptions {
  /** PostgreSQL connection URL (passed as positional arg to pg_dump). */
  connectionUrl: string;
  /** Absolute path for the output file. */
  outputPath: string;
}

export interface DumpResult {
  durationMs: number;
  sizeBytes: number;
}

/**
 * Run `pg_dump --format=custom` for a single database.
 * Throws on non-zero exit with the stderr output.
 */
export async function pgDump(options: DumpOptions): Promise<DumpResult> {
  const start = Date.now();
  const args = [
    "--format=custom",
    `--file=${options.outputPath}`,
    options.connectionUrl,
  ];

  try {
    await execFile("pg_dump", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`pg_dump failed: ${message}`);
  }

  const durationMs = Date.now() - start;
  const s = await stat(options.outputPath);
  return { durationMs, sizeBytes: s.size };
}

// ---------------------------------------------------------------------------
// pg_restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** PostgreSQL connection URL for the target database. */
  connectionUrl: string;
  /** Absolute path to the .dump file. */
  inputPath: string;
  /** Drop existing objects before restoring. */
  clean?: boolean;
  /** Skip ownership assignments (use current role). */
  noOwner?: boolean;
}

export interface RestoreResult {
  durationMs: number;
}

/**
 * Run `pg_restore` to restore a custom-format dump into a database.
 * Throws on non-zero exit with the stderr output.
 */
export async function pgRestore(
  options: RestoreOptions,
): Promise<RestoreResult> {
  const start = Date.now();
  const args = [`--dbname=${options.connectionUrl}`];

  if (options.clean) args.push("--clean", "--if-exists");
  if (options.noOwner) args.push("--no-owner");
  args.push(options.inputPath);

  try {
    await execFile("pg_restore", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`pg_restore failed: ${message}`);
  }

  return { durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

/**
 * Verify that `pg_dump` and `pg_restore` are available on PATH.
 * Throws with a descriptive message if either is missing.
 */
export async function checkPgToolsAvailable(): Promise<void> {
  for (const tool of ["pg_dump", "pg_restore"]) {
    try {
      await execFile(tool, ["--version"]);
    } catch {
      throw new Error(
        `${tool} is not available on PATH. Install PostgreSQL client tools.`,
      );
    }
  }
}
