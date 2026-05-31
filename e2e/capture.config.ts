import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

// Local-only Playwright config for the manual screenshot capture spec.
//
// Screenshots are not a CI artifact. The base e2e config (run by
// `pnpm test:e2e` in CI) ignores `capture-manual-screenshots.spec.ts`, so
// CI never takes screenshots — it stays pure regression. Manual screenshots
// are captured locally with `pnpm capture` and committed as static assets
// under docs/assets/.
//
// This config runs ONLY the capture spec: it clears the base `testIgnore`
// and narrows `testMatch` to that one file. Everything else — webServer,
// viewport, device scale factor, projects — is inherited from the base
// config so a captured screenshot matches what the regression suite renders.
export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: ["**/capture-manual-screenshots.spec.ts"],
});
