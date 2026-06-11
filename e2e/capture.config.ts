import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

// Local-only Playwright config for the manual screenshot capture spec.
//
// Screenshots are not a CI artifact. The base e2e config (run by
// `pnpm test:e2e` in CI) ignores `capture-manual-screenshots.spec.ts`, so
// CI never takes screenshots — it stays pure regression. Manual screenshots
// are captured locally with `pnpm capture` and committed as static assets
// under docs/assets/.
//
// This config runs ONLY the capture spec. It defines a dedicated single
// project (Desktop Chrome, matching the regression `chromium` project) so it
// is not subject to that project's `testIgnore`/grep filters, and narrows
// `testMatch` to the capture spec. Everything else — webServer, viewport,
// device scale factor — is inherited from the base config so a captured
// screenshot matches what the regression suite renders.
export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: ["**/capture-manual-screenshots.spec.ts"],
  projects: [{ name: "capture", use: { ...devices["Desktop Chrome"] } }],
});
