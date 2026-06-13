export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateExpectedOriginEnv } = await import(
      "@/lib/env/expected-origin"
    );
    const canonical = validateExpectedOriginEnv(
      process.env.EXPECTED_ORIGIN,
      process.env.NODE_ENV ?? "development",
    );
    if (canonical !== null) {
      // Persist the canonical form so that `canonicalOrigin()` reads the
      // normalised value (no trailing slash, lowercased scheme/host)
      // instead of the operator-entered raw value. Without this step an
      // operator-entered `EXPECTED_ORIGIN=https://host/` would still
      // produce `https://host//api/auth/callback` (double slash) in BFF
      // code that uses string concatenation.
      process.env.EXPECTED_ORIGIN = canonical;
    }

    const { runStartupMigrations } = await import("@/lib/db/migrate");
    await runStartupMigrations();
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );
    await installMtlsSighupHandler();
    const { installRetentionSweeper } = await import("@/lib/retention/sweeper");
    installRetentionSweeper();
    const { installRedactionJobWorker } = await import(
      "@/lib/instrumentation/redaction-job-worker"
    );
    await installRedactionJobWorker();
    const { installAnalysisJobWorker } = await import(
      "@/lib/instrumentation/analysis-job-worker"
    );
    await installAnalysisJobWorker();
    const { installAnalysisReconcileWorker } = await import(
      "@/lib/instrumentation/analysis-reconcile-worker"
    );
    installAnalysisReconcileWorker();
    const { installEventBackfillWorker } = await import(
      "@/lib/instrumentation/event-backfill-worker"
    );
    installEventBackfillWorker();
    const { installAuthPoolCleanup } = await import(
      "@/lib/instrumentation/auth-pool-cleanup"
    );
    installAuthPoolCleanup();
    const { installSelfFetchWorker } = await import(
      "@/lib/instrumentation/self-fetch-worker"
    );
    installSelfFetchWorker();
  }
}
