// ---------------------------------------------------------------------------
// Shared CLI utilities for backup/restore/verify commands
// ---------------------------------------------------------------------------

/** Log a timestamped message to stdout. */
export function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Parse CLI arguments from a `--key=value` / `--flag` format.
 * Returns a map of key → value (or "true" for boolean flags).
 * Calls `process.exit(2)` on unknown flags.
 */
export function parseKvArgs(
  argv: string[],
  knownKeys: Set<string>,
  knownFlags: Set<string>,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const arg of argv) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx); // strip leading --
      if (!knownKeys.has(key)) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(2);
      }
      result.set(key, arg.slice(eqIdx + 1));
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!knownFlags.has(key)) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(2);
      }
      result.set(key, "true");
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }

  return result;
}
