import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Sidebar — rendering
// ---------------------------------------------------------------------------

test.describe("Dashboard sidebar", () => {
  test("renders sidebar with logo and navigation items", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en");
    await expect(managerPage.getByText("AIMER")).toBeVisible();

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    await expect(nav.getByText("Home")).toBeVisible();
    await expect(nav.getByText("Events")).toBeVisible();
    await expect(nav.getByText("Analysis")).toBeVisible();
    await expect(nav.getByText("Reports")).toBeVisible();
    await expect(nav.getByText("Dashboard")).toBeVisible();
  });

  test("renders manager-only items for Manager role", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en");

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    await expect(nav.getByText("Members")).toBeVisible();
    await expect(nav.getByText("Customer Settings")).toBeVisible();
  });

  test("hides manager-only items for User role", async ({ userPage }) => {
    await userPage.goto("/en");

    const nav = userPage.getByRole("navigation", { name: "Main" });
    await expect(nav.getByText("Home")).toBeVisible();
    await expect(nav.getByText("Members")).toBeHidden();
    // Customer Settings is read-only visible for User role because the role
    // has `customer-redaction-ranges:read` and `customer-retention:read`.
    await expect(nav.getByText("Customer Settings")).toBeVisible();
  });

  test("highlights active navigation item", async ({ managerPage }) => {
    await managerPage.goto("/en/events");

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    const activeLink = nav.locator('a[aria-current="page"]');
    await expect(activeLink).toBeVisible();
    await expect(activeLink).toHaveAttribute("href", /\/events$/);
  });
});

// ---------------------------------------------------------------------------
// Sidebar — customer/environment selector
// ---------------------------------------------------------------------------

test.describe("Dashboard customer selector", () => {
  test("renders customer selector with accessible customers", async ({
    managerPage,
    testData,
  }) => {
    await managerPage.goto("/en");

    const select = managerPage.getByLabel("Customer");
    await expect(select).toBeVisible();
    await expect(select).toBeEnabled();
    await expect(select.getByText(testData.customer.name)).toBeAttached();
  });

  test("renders environment selector", async ({ managerPage }) => {
    await managerPage.goto("/en");

    const select = managerPage.getByLabel("Environment");
    await expect(select).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sidebar — collapse/expand
// ---------------------------------------------------------------------------

test.describe("Dashboard sidebar collapse", () => {
  test("collapses sidebar and hides nav labels", async ({ managerPage }) => {
    await managerPage.goto("/en");

    // Dismiss any Next.js dev overlay that may intercept pointer events
    await managerPage.evaluate(() => {
      for (const el of document.querySelectorAll("nextjs-portal")) {
        el.remove();
      }
    });

    await managerPage.getByRole("button", { name: "Collapse sidebar" }).click();

    // Customer selector should be hidden
    await expect(managerPage.getByLabel("Customer")).toBeHidden();

    // Expand button should appear
    await expect(
      managerPage.getByRole("button", { name: "Expand sidebar" }),
    ).toBeVisible();

    // Nav item text should be visible as small labels (collapsed shows icons + tiny text)
    const nav = managerPage.getByRole("navigation", { name: "Main" });
    await expect(nav.locator("a").first()).toBeVisible();
  });

  test("expands sidebar and shows nav labels again", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en");

    // Dismiss any Next.js dev overlay that may intercept pointer events
    await managerPage.evaluate(() => {
      for (const el of document.querySelectorAll("nextjs-portal")) {
        el.remove();
      }
    });

    // Collapse
    await managerPage.getByRole("button", { name: "Collapse sidebar" }).click();

    // Wait for collapse transition to settle
    await expect(managerPage.getByLabel("Customer")).toBeHidden();

    // Expand
    await managerPage.getByRole("button", { name: "Expand sidebar" }).click();

    // Labels and customer selector should be visible again
    await expect(managerPage.getByLabel("Customer")).toBeVisible();
    await expect(
      managerPage.getByRole("button", { name: "Collapse sidebar" }),
    ).toBeVisible();
  });

  test("persists collapsed state across navigation", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en");

    // Dismiss any Next.js dev overlay that may intercept pointer events
    await managerPage.evaluate(() => {
      for (const el of document.querySelectorAll("nextjs-portal")) {
        el.remove();
      }
    });

    // Collapse
    await managerPage.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(managerPage.getByLabel("Customer")).toBeHidden();

    // Navigate to a different page
    await managerPage.goto("/en/events");

    // Sidebar should still be collapsed
    await expect(managerPage.getByLabel("Customer")).toBeHidden();
    await expect(
      managerPage.getByRole("button", { name: "Expand sidebar" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

test.describe("Dashboard breadcrumbs", () => {
  test("shows breadcrumbs for events page", async ({ managerPage }) => {
    await managerPage.goto("/en/events");

    const breadcrumb = managerPage.getByRole("navigation", {
      name: "Breadcrumb",
    });
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb.getByText("Events")).toBeVisible();
  });

  test("shows nested breadcrumbs for settings/members", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en/settings/members");

    const breadcrumb = managerPage.getByRole("navigation", {
      name: "Breadcrumb",
    });
    await expect(breadcrumb.getByText("Settings")).toBeVisible();
    await expect(breadcrumb.getByText("Members")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// User profile section
// ---------------------------------------------------------------------------

test.describe("Dashboard user section", () => {
  test("renders user display name and sign out in dropdown", async ({
    managerPage,
    testData,
  }) => {
    await managerPage.goto("/en");

    // User name is visible in the header dropdown trigger
    await expect(
      managerPage.getByText(testData.manager.displayName),
    ).toBeVisible();

    // Open the user profile dropdown to reveal Sign Out
    await managerPage.getByText(testData.manager.displayName).click();
    await expect(managerPage.getByText("Sign Out")).toBeVisible();
  });

  test("renders theme toggle", async ({ managerPage }) => {
    await managerPage.goto("/en");

    // Theme toggle button should be in the sidebar
    await expect(
      managerPage.getByRole("button", { name: "Toggle theme" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Placeholder pages
// ---------------------------------------------------------------------------

test.describe("Dashboard placeholder pages", () => {
  test("events page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/events");
    await expect(
      managerPage.getByRole("heading", { name: "Events", level: 1 }),
    ).toBeVisible();
  });

  test("analysis page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/analysis");
    await expect(
      managerPage.getByRole("heading", { name: "Analysis", level: 1 }),
    ).toBeVisible();
  });

  test("reports page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/reports");
    await expect(
      managerPage.getByRole("heading", { name: "Reports", level: 1 }),
    ).toBeVisible();
  });

  test("dashboard page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/dashboard");
    await expect(
      managerPage.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test.describe("Dashboard navigation", () => {
  test("navigates between pages via sidebar links", async ({ managerPage }) => {
    await managerPage.goto("/en");

    // Click Events link
    await managerPage
      .getByRole("navigation", { name: "Main" })
      .getByText("Events")
      .click();

    await expect(
      managerPage.getByRole("heading", { name: "Events", level: 1 }),
    ).toBeVisible();
    await expect(managerPage).toHaveURL(/\/en\/events/);
  });

  test("logo links to home page", async ({ managerPage }) => {
    await managerPage.goto("/en/events");

    // Click logo (the AIMER link)
    await managerPage.getByText("AIMER").click();

    await expect(managerPage).toHaveURL(/\/en$/);
  });
});

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

test.describe("Dashboard locale", () => {
  test("renders sidebar in Korean", async ({ managerPage }) => {
    await managerPage.goto("/ko");

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    await expect(nav.getByText("홈")).toBeVisible();
    await expect(nav.getByText("이벤트")).toBeVisible();
    await expect(nav.getByText("분석")).toBeVisible();
    await expect(nav.getByText("보고서")).toBeVisible();
    await expect(nav.getByText("대시보드")).toBeVisible();
  });
});
