import { Pool } from "pg";
import { sweepGroupLifecycle } from "./lifecycle";

// Periodic group-lifecycle sweep (#510) — the backstop for any mutation site
// not individually hooked and for converging state after a partial failure
// (consistent with the #509 retention reaper). Re-evaluates every group:
// transfers ownership off a disqualified owner, suspends/resumes generation
// to match member operability, and auto-deletes groups whose last qualifying
// manager is gone (tearing the dedicated database down post-commit).
//
//   pnpm sweep:groups
//
// Idempotent: a converged group reconciles to no change, so the sweep is
// safe to run on any cadence (e.g. cron).
//
// Run via `tsx --conditions=react-server` (see package.json): `lifecycle.ts`
// transitively imports the `server-only`-tagged audit/teardown modules, which
// throw under a plain Node resolver. The `react-server` condition resolves
// `server-only` to its no-op, the same way the Next.js server bundle does.
async function main() {
  const authPool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const outcomes = await sweepGroupLifecycle(authPool, {
      actorContext: { actorId: "system", authContext: "admin" },
    });
    const deleted = outcomes.filter((o) => o.deleted).length;
    const transferred = outcomes.filter((o) => o.ownerTransferredTo).length;
    const suspended = outcomes.filter(
      (o) => o.lifecycleChangedTo === "suspended",
    ).length;
    const resumed = outcomes.filter(
      (o) => o.lifecycleChangedTo === "active",
    ).length;
    console.log(
      `Group lifecycle sweep complete: ${outcomes.length} evaluated, ` +
        `${transferred} transferred, ${suspended} suspended, ` +
        `${resumed} resumed, ${deleted} auto-deleted.`,
    );
  } finally {
    await authPool.end();
  }
}

main().catch((err) => {
  console.error("Group lifecycle sweep failed:", err);
  process.exit(1);
});
