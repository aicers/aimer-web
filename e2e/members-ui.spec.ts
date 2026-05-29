import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Helper: navigate and wait for data load
// ---------------------------------------------------------------------------

async function gotoMembers(
  page: import("@playwright/test").Page,
  locale: "en" | "ko" = "en",
) {
  const path =
    locale === "en" ? "/en/settings/members" : "/ko/settings/members";
  await page.goto(path);
  await expect(page.locator("table").first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Manager view — rendering
// ---------------------------------------------------------------------------

test.describe("Members page — Manager", () => {
  test("renders member list with both members", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const table = managerPage.locator("table").first();
    await expect(table.getByText(testData.manager.displayName)).toBeVisible();
    await expect(table.getByText(testData.user.displayName)).toBeVisible();
  });

  test("shows Invite Member button", async ({ managerPage }) => {
    await gotoMembers(managerPage);

    await expect(
      managerPage.getByRole("button", { name: "Invite Member" }),
    ).toBeVisible();
  });

  test("shows pending invitations section with empty state", async ({
    managerPage,
  }) => {
    await gotoMembers(managerPage);

    await expect(
      managerPage.getByRole("heading", { name: "Pending Invitations" }),
    ).toBeVisible();
    await expect(
      managerPage.getByText("No pending invitations."),
    ).toBeVisible();
  });

  test("shows Change Role and Remove buttons for other member", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await expect(
      userRow.getByRole("button", { name: "Change Role" }),
    ).toBeVisible();
    await expect(userRow.getByRole("button", { name: "Remove" })).toBeVisible();
  });

  test("shows Last Manager badge when only one Manager exists", async ({
    managerPage,
  }) => {
    await gotoMembers(managerPage);
    await expect(managerPage.getByText("Last Manager")).toBeVisible();
  });

  test("disables actions for the last Manager", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const managerRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.manager.displayName });
    await expect(
      managerRow.getByRole("button", { name: "Change Role" }),
    ).toBeDisabled();
    await expect(
      managerRow.getByRole("button", { name: "Remove" }),
    ).toBeDisabled();
  });

  test("marks the current user with (you) label", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const managerRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.manager.displayName });
    await expect(managerRow.getByText("(you)")).toBeVisible();

    // Other member should not have the (you) label
    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await expect(userRow.getByText("(you)")).toBeHidden();
  });

  test("displays role labels for each member", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const managerRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.manager.displayName });
    // Use nth(2) to target the role column (3rd td), avoiding the
    // displayName cell which also contains "Manager" in the name.
    await expect(managerRow.locator("td").nth(2)).toContainText("Manager");

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await expect(userRow.locator("td").nth(2)).toContainText("User");
  });
});

// ---------------------------------------------------------------------------
// Dialog interactions
// ---------------------------------------------------------------------------

test.describe("Members page — invite dialog", () => {
  test("opens invite dialog and validates empty email", async ({
    managerPage,
  }) => {
    await gotoMembers(managerPage);

    await managerPage.getByRole("button", { name: "Invite Member" }).click();

    // Dialog should be open
    await expect(
      managerPage.getByRole("heading", { name: "Invite Member" }),
    ).toBeVisible();
    await expect(
      managerPage.getByText("Send an invitation email to add a new member."),
    ).toBeVisible();

    // Submit without entering email
    await managerPage.getByRole("button", { name: "Send Invitation" }).click();

    // Validation error
    await expect(managerPage.getByText("This field is required")).toBeVisible();
  });

  test("validates invalid email format in invite dialog", async ({
    managerPage,
  }) => {
    await gotoMembers(managerPage);

    await managerPage.getByRole("button", { name: "Invite Member" }).click();

    // "user@host" passes HTML5 type="email" validation but fails the
    // app's stricter regex which requires a dot in the domain part.
    await managerPage.getByLabel("Email address").fill("user@host");
    await managerPage.getByRole("button", { name: "Send Invitation" }).click();

    await expect(
      managerPage.getByText("Please enter a valid email address"),
    ).toBeVisible();
  });

  test("closes invite dialog with Cancel button", async ({ managerPage }) => {
    await gotoMembers(managerPage);

    await managerPage.getByRole("button", { name: "Invite Member" }).click();
    await expect(
      managerPage.getByRole("heading", { name: "Invite Member" }),
    ).toBeVisible();

    await managerPage.getByRole("button", { name: "Cancel" }).click();

    // Dialog should be closed
    await expect(
      managerPage.getByRole("heading", { name: "Invite Member" }),
    ).toBeHidden();
  });

  test("sends invitation and shows success toast", async ({ managerPage }) => {
    await gotoMembers(managerPage);

    await managerPage.getByRole("button", { name: "Invite Member" }).click();

    const email = `invite-${Date.now()}@e2e.test`;
    await managerPage.getByLabel("Email address").fill(email);
    // Role defaults to User
    await managerPage.getByRole("button", { name: "Send Invitation" }).click();

    // Success toast
    await expect(
      managerPage.getByText(`Invitation sent to ${email}.`),
    ).toBeVisible();

    // Dialog should close
    await expect(
      managerPage.getByRole("heading", { name: "Invite Member" }),
    ).toBeHidden();

    // Pending invitations section should now list the invitation
    await expect(
      managerPage.locator("table").nth(1).getByText(email),
    ).toBeVisible();
  });
});

test.describe("Members page — remove dialog", () => {
  test("opens remove confirmation dialog and cancels", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await userRow.getByRole("button", { name: "Remove" }).click();

    // Confirmation dialog
    await expect(
      managerPage.getByRole("heading", { name: "Remove Member" }),
    ).toBeVisible();
    await expect(
      managerPage.getByText(
        `Are you sure you want to remove ${testData.user.displayName}`,
      ),
    ).toBeVisible();

    // Cancel — member should still exist
    await managerPage.getByRole("button", { name: "Cancel" }).click();
    await expect(
      managerPage.getByRole("heading", { name: "Remove Member" }),
    ).toBeHidden();
    await expect(
      managerPage.getByText(testData.user.displayName),
    ).toBeVisible();
  });
});

test.describe("Members page — change role dialog", () => {
  test("opens change role confirmation dialog and cancels", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await userRow.getByRole("button", { name: "Change Role" }).click();

    // Confirmation dialog
    await expect(
      managerPage.getByRole("heading", { name: "Change Role" }),
    ).toBeVisible();
    await expect(
      managerPage.getByText(
        `Change the role of ${testData.user.displayName} to Manager?`,
      ),
    ).toBeVisible();

    // Cancel
    await managerPage.getByRole("button", { name: "Cancel" }).click();
    await expect(
      managerPage.getByRole("heading", { name: "Change Role" }),
    ).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Mutation — role change
// ---------------------------------------------------------------------------

test.describe("Members page — role change", () => {
  test("confirms role change and updates the member list", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await userRow.getByRole("button", { name: "Change Role" }).click();

    // Confirm dialog
    await expect(
      managerPage.getByText(
        `Change the role of ${testData.user.displayName} to Manager?`,
      ),
    ).toBeVisible();

    // Click Change Role button inside dialog (not the table button)
    await managerPage
      .getByRole("dialog")
      .getByRole("button", { name: "Change Role" })
      .click();

    // Success toast
    await expect(
      managerPage.getByText("Action completed successfully."),
    ).toBeVisible();

    // After refresh, the User should now have the Manager role
    const updatedRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await expect(updatedRow.getByText("Manager")).toBeVisible();

    // Last Manager badge should disappear since there are now two Managers
    await expect(managerPage.getByText("Last Manager")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Mutation — member removal
// ---------------------------------------------------------------------------

test.describe("Members page — member removal", () => {
  test("confirms member removal and updates the member list", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    // Ensure the User member is present
    await expect(
      managerPage.getByText(testData.user.displayName),
    ).toBeVisible();

    const userRow = managerPage
      .locator("tr")
      .filter({ hasText: testData.user.displayName });
    await userRow.getByRole("button", { name: "Remove" }).click();

    // Confirm dialog
    await expect(
      managerPage.getByText(
        `Are you sure you want to remove ${testData.user.displayName}`,
      ),
    ).toBeVisible();

    // Click Remove button inside dialog
    await managerPage
      .getByRole("dialog")
      .getByRole("button", { name: "Remove" })
      .click();

    // Success toast
    await expect(
      managerPage.getByText("Action completed successfully."),
    ).toBeVisible();

    // The removed member should no longer appear in the table. Scope the
    // assertion to table rows so it is not confused by the confirmation
    // dialog's description, which embeds the same display name and may
    // still be present during its close animation.
    await expect(
      managerPage.locator("tr").filter({ hasText: testData.user.displayName }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Mutation — invitation lifecycle (invite → revoke)
// ---------------------------------------------------------------------------

test.describe("Members page — invitation lifecycle", () => {
  test("sends invitation then revokes it", async ({ managerPage }) => {
    await gotoMembers(managerPage);

    // Send invitation
    await managerPage.getByRole("button", { name: "Invite Member" }).click();
    const email = `lifecycle-${Date.now()}@e2e.test`;
    await managerPage.getByLabel("Email address").fill(email);
    await managerPage.getByRole("button", { name: "Send Invitation" }).click();

    // Wait for invitation to appear in the pending list (use second table
    // to avoid matching the success toast which also contains the email)
    await expect(
      managerPage.locator("table").nth(1).getByText(email),
    ).toBeVisible();

    // Revoke the invitation
    const invRow = managerPage.locator("tr").filter({ hasText: email });
    await invRow.getByRole("button", { name: "Revoke" }).click();

    // Confirm revoke dialog
    await expect(
      managerPage.getByText(
        `Are you sure you want to revoke the invitation for ${email}?`,
      ),
    ).toBeVisible();
    await managerPage
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    // Success toast
    await expect(
      managerPage.getByText(`Invitation for ${email} has been revoked.`),
    ).toBeVisible();

    // After revocation, the pending invitations table should be gone
    // (empty state renders a <p> instead of a <table>).
    await expect(
      managerPage.getByText("No pending invitations."),
    ).toBeVisible();
  });

  test("shows error when inviting an existing member email", async ({
    managerPage,
    testData,
  }) => {
    await gotoMembers(managerPage);

    await managerPage.getByRole("button", { name: "Invite Member" }).click();
    // Use the existing User member's email
    await managerPage.getByLabel("Email address").fill(testData.user.email);
    await managerPage.getByRole("button", { name: "Send Invitation" }).click();

    // Error toast for already-member
    await expect(
      managerPage.getByText(
        "This email is already a member of the organization.",
      ),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// User role — permission boundary
// ---------------------------------------------------------------------------

test.describe("Members page — User role", () => {
  test("User cannot view member list (permission denied)", async ({
    userPage,
  }) => {
    await userPage.goto("/en/settings/members");

    // The page should show an error because /api/members returns 403
    await expect(
      userPage.getByText("An error occurred. Please try again."),
    ).toBeVisible();

    // The member table should NOT be visible
    await expect(userPage.locator("table")).toBeHidden();

    // The Invite button should NOT be visible
    await expect(
      userPage.getByRole("button", { name: "Invite Member" }),
    ).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Locale switching
// ---------------------------------------------------------------------------

test.describe("Members page — locale", () => {
  test("renders in Korean at default locale path", async ({ managerPage }) => {
    await gotoMembers(managerPage, "ko");

    await expect(
      managerPage.getByRole("heading", { name: "멤버", level: 1 }),
    ).toBeVisible();
  });

  test("renders in English at /en path", async ({ managerPage }) => {
    await gotoMembers(managerPage);

    await expect(
      managerPage.getByRole("heading", { name: "Members", level: 1 }),
    ).toBeVisible();
  });
});
