import { expect, test } from "@playwright/test";

test.describe("bridge deny page reasons", () => {
  test("renders bridge_expired reason", async ({ page }) => {
    await page.goto("/deny?reason=bridge_expired");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(
      page.locator("text=bridge connection has expired"),
    ).toBeVisible();
  });

  test("renders bridge_customer_mismatch reason", async ({ page }) => {
    await page.goto("/deny?reason=bridge_customer_mismatch");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=could not be matched")).toBeVisible();
  });

  test("renders bridge_customer_inactive reason", async ({ page }) => {
    await page.goto("/deny?reason=bridge_customer_inactive");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=customers are inactive")).toBeVisible();
  });

  test("renders bridge_environment_inactive reason", async ({ page }) => {
    await page.goto("/deny?reason=bridge_environment_inactive");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=environment is inactive")).toBeVisible();
  });

  test("renders bridge_no_access reason", async ({ page }) => {
    await page.goto("/deny?reason=bridge_no_access");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(
      page.locator("text=do not have access to the requested"),
    ).toBeVisible();
  });

  test("back to sign in link is visible on bridge deny", async ({ page }) => {
    await page.goto("/deny?reason=bridge_expired");
    const link = page.locator('a[href="/api/auth/sign-in"]');
    await expect(link).toBeVisible();
  });
});
