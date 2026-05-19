export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupMigrations } = await import("@/lib/db/migrate");
    await runStartupMigrations();
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );
    await installMtlsSighupHandler();
    const { installRetentionSweeper } = await import("@/lib/retention/sweeper");
    installRetentionSweeper();
  }
}
