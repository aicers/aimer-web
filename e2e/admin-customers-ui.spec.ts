import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E UI tests for the admin customers page — covers acceptance criteria
// from issue #196 that route-level / unit tests cannot:
//   - Create dialog renders external_key inline help with a link to the
//     canonical operations guide.
//   - Editing external_key to a non-equal value triggers the
//     non-dismissable effect-warning modal.
//   - Editing only name / description does NOT trigger the warning.
// ---------------------------------------------------------------------------

test.describe("Admin customers page — external_key inline help (create)", () => {
  test("create dialog shows inline help with operations guide link", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/customers");
    await expect(
      adminPage.getByRole("heading", { name: "Customers", level: 1 }),
    ).toBeVisible();

    await adminPage.getByRole("button", { name: "Create Customer" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Create Customer" }),
    ).toBeVisible();

    const help = adminPage.locator("#customer-external-key-help");
    await expect(help).toBeVisible();
    await expect(help).toContainText("globally unique business identifier");
    await expect(help).toContainText("aice-web-next");
    await expect(help).toContainText("bridge");

    const link = help.getByRole("link", { name: "Operations guide" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      /cross-system-customer-identification/,
    );
    await expect(link).toHaveAttribute("target", "_blank");

    const input = adminPage.locator("#customer-external-key");
    await expect(input).toHaveAttribute(
      "aria-describedby",
      "customer-external-key-help",
    );
  });

  test("Korean locale renders the inline help link", async ({ adminPage }) => {
    await adminPage.goto("/ko/admin/customers");
    await adminPage.getByRole("button", { name: "고객 생성" }).click();

    const help = adminPage.locator("#customer-external-key-help");
    await expect(help).toBeVisible();

    const link = help.getByRole("link", { name: "운영 가이드 보기" });
    await expect(link).toHaveAttribute(
      "href",
      /\/ko\/cross-system-customer-identification/,
    );
  });
});

test.describe("Admin customers page — external_key change warning (edit)", () => {
  test("editing external_key opens the non-dismissable warning modal", async ({
    adminPage,
    testData,
  }) => {
    await adminPage.goto("/en/admin/customers");
    await adminPage.waitForSelector("table tbody tr");

    const row = adminPage.locator("tbody tr", {
      hasText: testData.customer.name,
    });
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Edit Customer" }),
    ).toBeVisible();

    const keyInput = adminPage.locator("#customer-edit-external-key");
    await keyInput.fill(`${testData.customer.externalKey}-changed`);

    await adminPage.getByRole("button", { name: "Save" }).click();

    const warning = adminPage.getByRole("heading", {
      name: "Confirm external_key change",
    });
    await expect(warning).toBeVisible();

    // Must NOT close on Escape — confirmation is required.
    await adminPage.keyboard.press("Escape");
    await expect(warning).toBeVisible();

    // The confirm button is present (explicit confirm required).
    await expect(
      adminPage.getByRole("button", { name: "Yes, change external_key" }),
    ).toBeVisible();

    // Cancel out so no PATCH is sent and DB state is preserved for cleanup.
    const warningDialog = adminPage
      .locator('[role="dialog"]')
      .filter({ hasText: "Confirm external_key change" });
    await warningDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(warning).not.toBeVisible();
  });

  test("editing only the name does NOT trigger the warning", async ({
    adminPage,
    testData,
  }) => {
    await adminPage.goto("/en/admin/customers");
    await adminPage.waitForSelector("table tbody tr");

    const row = adminPage.locator("tbody tr", {
      hasText: testData.customer.name,
    });
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Edit Customer" }),
    ).toBeVisible();

    const nameInput = adminPage.locator("#customer-edit-name");
    const renamed = `${testData.customer.name} (renamed)`;
    await nameInput.fill(renamed);

    await adminPage.getByRole("button", { name: "Save" }).click();

    // Warning modal must not appear.
    await expect(
      adminPage.getByRole("heading", { name: "Confirm external_key change" }),
    ).toHaveCount(0);

    // Edit dialog should close on a successful save.
    await expect(
      adminPage.getByRole("heading", { name: "Edit Customer" }),
    ).toBeHidden();

    // Verify the rename took effect (and not the warning path).
    await expect(
      adminPage.locator("tbody tr", { hasText: renamed }),
    ).toBeVisible();
  });
});
