import { defineConfig, devices } from "@playwright/test";

// Specs that are NOT safe to run concurrently — either they mutate
// process-wide global state, or they share a global table with a sibling spec
// via a beforeAll-seed / afterAll-clean lifecycle that assumes sequential
// execution:
//   - session-policy-api: reads/writes the single global session-policy row.
//   - kek-rotation-api: rotates the shared OpenBao `staging-events` Transit key
//     and runs a DB-wide KEK rewrap scan.
//   - admin-detection-ui / admin-detection-alerts-auth: share the global
//     `suspicious_activity_alerts` table (the UI empty-state test requires it
//     globally empty).
//   - admin-audit-logs-ui / admin-audit-logs-auth: share the global
//     `audit_logs` table.
// Each runs in its own one-file project, wired into a dependency CHAIN that
// starts after `chromium`. Playwright runs a project's dependencies to
// completion first, so a chain forces its files to execute strictly one at a
// time — after the parallel pool has drained — within a single test run (one
// dev server).
//
// The files split into two LANES that touch disjoint resources, so the lanes
// run concurrently with each other while staying serial *within* a lane.
// Files that share a global table sit in the SAME lane so they never overlap;
// the per-lane tail (session-policy / kek-rotation) is load-balanced across
// the two lanes.
const SERIAL_LANES = [
  // Lane A: the suspicious_activity_alerts pair, then the session-policy row.
  {
    prefix: "a",
    files: [
      "admin-detection-ui.spec.ts",
      "admin-detection-alerts-auth.spec.ts",
      "session-policy-api.spec.ts",
    ],
  },
  // Lane B: the audit_logs pair, then the KEK rotation (DB-wide rewrap).
  {
    prefix: "b",
    files: [
      "admin-audit-logs-ui.spec.ts",
      "admin-audit-logs-auth.spec.ts",
      "kek-rotation-api.spec.ts",
    ],
  },
];

const SERIAL_FILES = SERIAL_LANES.flatMap((lane) => lane.files);

const serialChain = SERIAL_LANES.flatMap((lane) =>
  lane.files.map((file, i) => ({
    name: `serial-${lane.prefix}${i + 1}`,
    use: { ...devices["Desktop Chrome"] },
    grepInvert: /@oidc/,
    testMatch: [`**/${file}`],
    // One file per project, run serially within the file, and after the
    // previous link in its lane (the first link waits for the `chromium` pool).
    fullyParallel: false,
    dependencies: [i === 0 ? "chromium" : `serial-${lane.prefix}${i}`],
  })),
);

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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // ubuntu-latest CI runners have 4 vCPUs; locally Playwright defaults to
  // half the cores. Per-test data isolation (unique-suffix seeding in
  // fixtures/db.ts) makes the suite safe to parallelize; the non-parallel-safe
  // specs are quarantined in the serial chain below.
  workers: process.env.CI ? 4 : undefined,
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
      // Default per-PR regression project, run in parallel. The @oidc specs
      // (real Keycloak OIDC + Mailpit, #452) are excluded via grepInvert so
      // `pnpm test:e2e` never needs those services. The non-parallel-safe
      // specs are excluded here and run in the serial chain instead.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /@oidc/,
      // A project-level `testIgnore` REPLACES the top-level one, so the
      // capture spec must be repeated here alongside the serial specs.
      testIgnore: [
        "**/capture-manual-screenshots.spec.ts",
        ...SERIAL_FILES.map((f) => `**/${f}`),
      ],
    },
    ...serialChain,
    // OIDC project: selects ONLY @oidc specs. Defined only when E2E_OIDC is
    // set so a plain `pnpm test:e2e` never tries to run it (it needs a full
    // Keycloak + Mailpit stack). Run via `pnpm test:e2e:oidc` in the
    // `E2E OIDC` CI job — that script pins `--workers=1` because the @oidc
    // specs share one Mailpit/Keycloak instance and the same invitation email,
    // so they must run sequentially.
    ...(process.env.E2E_OIDC
      ? [
          {
            name: "oidc-chromium",
            use: { ...devices["Desktop Chrome"] },
            grep: /@oidc/,
            fullyParallel: false,
          },
        ]
      : []),
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
