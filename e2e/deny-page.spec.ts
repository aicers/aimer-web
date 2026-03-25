import { expect, test } from "@playwright/test";

test.describe("deny page", () => {
  test("renders no_access reason", async ({ page }) => {
    await page.goto("/deny?reason=no_access");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=customer workspace")).toBeVisible();
    await expect(page.locator("text=Back to Sign In")).toBeVisible();
  });

  test("renders account_inactive reason", async ({ page }) => {
    await page.goto("/deny?reason=account_inactive");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=suspended or disabled")).toBeVisible();
  });

  test("renders generic error for unknown reason", async ({ page }) => {
    await page.goto("/deny?reason=unknown");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=error occurred")).toBeVisible();
  });

  test("renders generic error with no reason param", async ({ page }) => {
    await page.goto("/deny");
    await expect(page.locator("h1")).toContainText("Access Denied");
  });

  test("renders invitation_expired reason", async ({ page }) => {
    await page.goto("/deny?reason=invitation_expired");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(
      page.locator("text=expired or is no longer valid"),
    ).toBeVisible();
  });

  test("renders invitation_email_mismatch reason", async ({ page }) => {
    await page.goto("/deny?reason=invitation_email_mismatch");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(
      page.locator("text=does not match the invited email"),
    ).toBeVisible();
  });

  test("renders invitation_email_not_verified reason", async ({ page }) => {
    await page.goto("/deny?reason=invitation_email_not_verified");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(page.locator("text=has not been verified")).toBeVisible();
  });

  test("back to sign in link points to /api/auth/sign-in", async ({ page }) => {
    await page.goto("/deny?reason=no_access");
    const link = page.locator('a[href="/api/auth/sign-in"]');
    await expect(link).toBeVisible();
  });
});
