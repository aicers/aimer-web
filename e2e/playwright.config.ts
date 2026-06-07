import { defineConfig, devices } from "@playwright/test";

// CI prerequisites for auth-fixture-based UI tests:
// - PostgreSQL with migrated auth_db (DATABASE_URL / DATABASE_MIGRATION_URL)
// - JWT key pair at DATA_DIR/keys/ (ec-private.pem, ec-public.pem)
// - CSRF_SECRET environment variable
// These are provided by the docker-compose dev stack; see .env.example.

export default defineConfig({
  testDir: ".",
  // Screenshots are not a CI artifact. `capture-manual-screenshots.spec.ts`
  // is the only spec that takes screenshots; it is excluded here so the CI
  // E2E run (`pnpm test:e2e`) stays pure regression and never writes images.
  // Manual screenshots are captured locally via `pnpm capture` (see
  // e2e/capture.config.ts) and committed as static assets under docs/assets/.
  testIgnore: ["**/capture-manual-screenshots.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // Default per-PR regression project. Tier-2 specs (real Keycloak OIDC +
      // Mailpit, #452) are excluded here via grepInvert so `pnpm test:e2e`
      // never needs those services; they run only in the nightly workflow.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /@tier2/,
    },
    {
      // Tier-2 project: selects ONLY @tier2 specs. Run via
      // `pnpm test:e2e:tier2` in .github/workflows/e2e-nightly.yml against a
      // full stack (Keycloak + Mailpit + Postgres + OpenBao).
      name: "tier2-chromium",
      use: { ...devices["Desktop Chrome"] },
      grep: /@tier2/,
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
