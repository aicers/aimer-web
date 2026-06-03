import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Sidebar — rendering
// ---------------------------------------------------------------------------

test.describe("Dashboard sidebar", () => {
  test("renders sidebar with logo and navigation items", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en");
    await expect(managerPage.getByAltText("Clumit Insight")).toBeVisible();

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    await expect(nav.getByText("Overview")).toBeVisible();
    await expect(nav.getByText("Reports")).toBeVisible();
    await expect(nav.getByText("Threat Stories")).toBeVisible();
    await expect(nav.getByText("Suspicious Events")).toBeVisible();
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
    await expect(nav.getByText("Overview")).toBeVisible();
    await expect(nav.getByText("Members")).toBeHidden();
    // Customer Settings is read-only visible for User role because the role
    // has `customer-redaction-ranges:read` and `customer-retention:read`.
    await expect(nav.getByText("Customer Settings")).toBeVisible();
  });

  test("highlights active navigation item", async ({ managerPage }) => {
    // Use a top-level route that renders in place (`/reports`) rather than a
    // stub that redirects elsewhere (e.g. `/events` → `/suspicious-events`),
    // so the active-item assertion runs against a stable pathname.
    await managerPage.goto("/en/reports");

    const nav = managerPage.getByRole("navigation", { name: "Main" });
    const activeLink = nav.locator('a[aria-current="page"]');
    await expect(activeLink).toBeVisible();
    await expect(activeLink).toHaveAttribute("href", /\/reports$/);
  });
});

// ---------------------------------------------------------------------------
// Sidebar — customer scope selector
// ---------------------------------------------------------------------------

test.describe("Dashboard customer scope", () => {
  test("renders scope selector with accessible customers", async ({
    managerPage,
    testData,
  }) => {
    await managerPage.goto("/en");

    const scope = managerPage.getByRole("list", { name: "Customer scope" });
    await expect(scope).toBeVisible();
    await expect(
      scope.getByRole("checkbox", { name: testData.customer.name }),
    ).toBeVisible();
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

    // Scope selector should be hidden
    await expect(
      managerPage.getByRole("list", { name: "Customer scope" }),
    ).toBeHidden();

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
    await expect(
      managerPage.getByRole("list", { name: "Customer scope" }),
    ).toBeHidden();

    // Expand
    await managerPage.getByRole("button", { name: "Expand sidebar" }).click();

    // Labels and scope selector should be visible again
    await expect(
      managerPage.getByRole("list", { name: "Customer scope" }),
    ).toBeVisible();
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
    await expect(
      managerPage.getByRole("list", { name: "Customer scope" }),
    ).toBeHidden();

    // Navigate to a different page
    await managerPage.goto("/en/events");

    // Sidebar should still be collapsed
    await expect(
      managerPage.getByRole("list", { name: "Customer scope" }),
    ).toBeHidden();
    await expect(
      managerPage.getByRole("button", { name: "Expand sidebar" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

test.describe("Dashboard breadcrumbs", () => {
  test("shows breadcrumbs for reports page", async ({ managerPage }) => {
    // `/reports` renders in place and is a breadcrumb segment. WS5 also added
    // crumb labels for `/overview`, `/suspicious-events`, and `/threat-stories`
    // (covered by the breadcrumbs unit tests).
    await managerPage.goto("/en/reports");

    const breadcrumb = managerPage.getByRole("navigation", {
      name: "Breadcrumb",
    });
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb.getByText("Reports")).toBeVisible();
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
// Top-level pages — cross-customer overviews (WS2, #391)
//
// The sidebar now links to the cross-customer overview routes directly
// (`/overview`, `/reports`, `/threat-stories`, `/suspicious-events`; WS5).
// The old paths (`/dashboard`, `/events`, `/analysis`) remain as
// query-preserving redirect stubs so any bookmarked links stay live.
// ---------------------------------------------------------------------------

test.describe("Dashboard top-level pages", () => {
  test("overview page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/overview");
    await expect(
      managerPage.getByRole("heading", { name: "Overview", level: 1 }),
    ).toBeVisible();
  });

  test("reports page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/reports");
    await expect(
      managerPage.getByRole("heading", { name: "Reports", level: 1 }),
    ).toBeVisible();
  });

  test("threat stories page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/threat-stories");
    await expect(
      managerPage.getByRole("heading", { name: "Threat Stories", level: 1 }),
    ).toBeVisible();
  });

  test("suspicious events page renders", async ({ managerPage }) => {
    await managerPage.goto("/en/suspicious-events");
    await expect(
      managerPage.getByRole("heading", { name: "Suspicious Events", level: 1 }),
    ).toBeVisible();
  });

  test("events stub redirects to suspicious events overview", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en/events");
    await expect(managerPage).toHaveURL(/\/en\/suspicious-events/);
    await expect(
      managerPage.getByRole("heading", { name: "Suspicious Events", level: 1 }),
    ).toBeVisible();
  });

  test("analysis stub redirects to overview", async ({ managerPage }) => {
    await managerPage.goto("/en/analysis");
    await expect(managerPage).toHaveURL(/\/en\/overview/);
    await expect(
      managerPage.getByRole("heading", { name: "Overview", level: 1 }),
    ).toBeVisible();
  });

  test("dashboard stub redirects to overview", async ({ managerPage }) => {
    await managerPage.goto("/en/dashboard");
    await expect(managerPage).toHaveURL(/\/en\/overview/);
    await expect(
      managerPage.getByRole("heading", { name: "Overview", level: 1 }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test.describe("Dashboard navigation", () => {
  test("navigates between pages via sidebar links", async ({ managerPage }) => {
    await managerPage.goto("/en");

    // The sidebar links directly to the cross-customer Suspicious Events
    // overview (WS5 restructure; WS2 destination).
    await managerPage
      .getByRole("navigation", { name: "Main" })
      .getByText("Suspicious Events")
      .click();

    await expect(
      managerPage.getByRole("heading", { name: "Suspicious Events", level: 1 }),
    ).toBeVisible();
    await expect(managerPage).toHaveURL(/\/en\/suspicious-events/);
  });

  test("logo links to home page", async ({ managerPage }) => {
    await managerPage.goto("/en/events");

    // Click logo (the Clumit Insight link)
    await managerPage.getByRole("link", { name: "Clumit Insight" }).click();

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
    await expect(nav.getByText("개요")).toBeVisible();
    await expect(nav.getByText("보고서")).toBeVisible();
    await expect(nav.getByText("위협 스토리")).toBeVisible();
    await expect(nav.getByText("의심 이벤트")).toBeVisible();
  });
});
