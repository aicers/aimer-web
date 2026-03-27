import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight .env loader for Playwright fixtures.
 * Does not override existing environment variables.
 */
export function loadEnv(): void {
  // Use process.cwd() instead of import.meta.dirname because Playwright's
  // esbuild transform outputs CJS — import.meta is not available in CJS.
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
