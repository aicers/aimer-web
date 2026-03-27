import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Authenticated smoke tests — verify that authenticated pages load
// correctly and that API-backed pages enforce auth.
//
// NOTE: In non-production without KEYCLOAK_URL / KEYCLOAK_REALM the
// middleware skips auth entirely, so page-level redirects cannot be
// tested here. Instead we focus on API-backed pages where the server
// action / API route performs its own JWT + session verification.
//
// Admin pages are excluded because admin auth requires MFA ACR
// verification and Keycloak realm roles that cannot be replicated by
// simple JWT injection.
// ---------------------------------------------------------------------------

test.describe("Authenticated smoke — API-backed pages", () => {
  test("members page loads for authenticated Manager", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en/settings/members");

    await expect(
      managerPage.getByRole("heading", { name: "Members", level: 1 }),
    ).toBeVisible();
    // Should see the member table (API returned 200)
    await expect(managerPage.locator("table").first()).toBeVisible();
  });

  test("members page shows error for authenticated User (403)", async ({
    userPage,
  }) => {
    await userPage.goto("/en/settings/members");

    // The API returns 403 for User role → UI shows error
    await expect(
      userPage.getByText("An error occurred. Please try again."),
    ).toBeVisible();
    await expect(userPage.locator("table")).toBeHidden();
  });
});
