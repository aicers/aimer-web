import type { Pool } from "pg";
import { analyzeBridgeAbuse } from "./bridge-abuse";
import { analyzeConcurrentMultiIp } from "./concurrent-multi-ip";
import { analyzeConsecutiveDenials } from "./consecutive-denials";
import { analyzeSessionIpMismatch } from "./session-ip-mismatch";

/**
 * Run all periodic detection analyzers. Returns total alerts created.
 */
export async function runAllAnalyzers(pool: Pool): Promise<number> {
  let total = 0;

  const analyzers = [
    analyzeConsecutiveDenials,
    analyzeSessionIpMismatch,
    analyzeConcurrentMultiIp,
    analyzeBridgeAbuse,
  ];

  for (const analyze of analyzers) {
    try {
      total += await analyze(pool);
    } catch (err) {
      console.error(`[detection] Analyzer failed:`, err);
    }
  }

  return total;
}
