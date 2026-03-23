import { expect, test } from "@playwright/test";

test.describe("admin deny page", () => {
  test("renders admin MFA required reason", async ({ page }) => {
    await page.goto("/deny?reason=admin_mfa_required");
    await expect(page.locator("h1")).toContainText("Access Denied");
    await expect(
      page.locator("text=Multi-factor authentication"),
    ).toBeVisible();
  });

  test("renders admin auth too old reason", async ({ page }) => {
    await page.goto("/deny?reason=admin_auth_too_old");
    await expect(page.locator("text=authentication has expired")).toBeVisible();
  });

  test("renders admin role missing reason", async ({ page }) => {
    await page.goto("/deny?reason=admin_role_missing");
    await expect(page.locator("text=System Admin role")).toBeVisible();
  });

  test("renders admin not eligible reason", async ({ page }) => {
    await page.goto("/deny?reason=admin_not_eligible");
    await expect(page.locator("text=not eligible")).toBeVisible();
  });
});
