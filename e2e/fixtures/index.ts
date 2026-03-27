import { test as base, type Page } from "@playwright/test";
import { injectAuthCookies } from "./auth";
import { cleanupTestData, closePool, seedTestData, type TestData } from "./db";
import { loadEnv } from "./env";

// Load .env so fixture code can read DATABASE_URL, CSRF_SECRET, etc.
loadEnv();

export { expect } from "@playwright/test";
export type { TestAccount, TestData } from "./db";

// ---------------------------------------------------------------------------
// Extended test with auth fixtures
// ---------------------------------------------------------------------------

export const test = base.extend<{
  /** Seeded test data (customer, accounts, sessions, roles). */
  testData: TestData;
  /** Browser page authenticated as a Manager. */
  managerPage: Page;
  /** Browser page authenticated as a User. */
  userPage: Page;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture API requires destructuring
  testData: async ({}, use) => {
    const data = await seedTestData();
    await use(data);
    await cleanupTestData(data);
  },

  managerPage: async ({ browser, baseURL, testData }, use) => {
    const context = await browser.newContext({ baseURL: baseURL ?? undefined });
    await injectAuthCookies(context, testData.manager, "general");
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  userPage: async ({ browser, baseURL, testData }, use) => {
    const context = await browser.newContext({ baseURL: baseURL ?? undefined });
    await injectAuthCookies(context, testData.user, "general");
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

// Close the shared DB pool when the worker exits.
base.afterAll(async () => {
  await closePool();
});
