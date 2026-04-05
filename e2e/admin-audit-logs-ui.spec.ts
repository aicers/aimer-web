import { expect, test } from "./fixtures";

// E2E UI tests for the audit log viewer page.
// Uses the admin fixture for authenticated browser access.

// ---------------------------------------------------------------------------
// Helpers — seed / cleanup audit logs for tests that require table data
// ---------------------------------------------------------------------------

async function insertAuditLog(
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const auditUrl =
    process.env.AUDIT_DATABASE_MIGRATION_URL ??
    process.env.AUDIT_DATABASE_URL ??
    "";
  if (!auditUrl) throw new Error("AUDIT_DATABASE_URL is required");

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: auditUrl });
  try {
    const defaults = {
      actor_id: "e2e-ui-actor-00000000-0000-0000-0000-000000000001",
      auth_context: "admin",
      action: "e2e.ui_test_action",
      target_type: "test",
      target_id: null,
      details: JSON.stringify({ test: true }),
      ip_address: "127.0.0.1",
      sid: null,
      customer_id: null,
      aice_id: null,
      correlation_id: null,
      ...overrides,
    };

    const result = await pool.query(
      `INSERT INTO audit_logs
         (actor_id, auth_context, action, target_type, target_id,
          details, ip_address, sid, customer_id, aice_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        defaults.actor_id,
        defaults.auth_context,
        defaults.action,
        defaults.target_type,
        defaults.target_id,
        defaults.details,
        defaults.ip_address,
        defaults.sid,
        defaults.customer_id,
        defaults.aice_id,
        defaults.correlation_id,
      ],
    );
    return result.rows[0].id;
  } finally {
    await pool.end();
  }
}

async function cleanupAuditLogs(): Promise<void> {
  const auditUrl =
    process.env.AUDIT_DATABASE_MIGRATION_URL ??
    process.env.AUDIT_DATABASE_URL ??
    "";
  if (!auditUrl) return;

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: auditUrl });
  try {
    await pool.query(
      "DELETE FROM audit_logs WHERE actor_id LIKE 'e2e-ui-actor-%'",
    );
  } finally {
    await pool.end();
  }
}

test.describe("Audit logs UI — Admin", () => {
  test.beforeAll(async () => {
    await cleanupAuditLogs();

    await insertAuditLog({
      action: "e2e.ui_action_a",
      auth_context: "general",
    });
    await insertAuditLog({
      action: "e2e.ui_action_b",
      auth_context: "admin",
    });
    await insertAuditLog({
      action: "e2e.ui_action_a",
      auth_context: "admin",
      correlation_id: "e2e00000-0000-0000-0000-000000000099",
    });
  });

  test.afterAll(async () => {
    await cleanupAuditLogs();
  });
  test("admin layout has sidebar with audit log nav link", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin");

    // Sidebar should contain the Audit Log link
    const auditLink = adminPage.locator('nav[aria-label="Admin"] a', {
      hasText: "Audit Log",
    });
    await expect(auditLink).toBeVisible();

    // Click it to navigate
    await auditLink.click();
    await expect(adminPage).toHaveURL(/\/en\/admin\/audit-logs/);
    await expect(adminPage.locator("h1")).toHaveText("Audit Logs");
  });

  test("admin sign-out button is present", async ({ adminPage, testData }) => {
    await adminPage.goto("/en/admin");

    // Open the user profile dropdown to reveal Sign Out
    await adminPage.getByText(testData.admin.displayName).click();
    await expect(adminPage.getByText("Sign Out")).toBeVisible();
  });

  test("admin layout shows mobile menu trigger on small viewport", async ({
    adminPage,
  }) => {
    await adminPage.setViewportSize({ width: 375, height: 667 });
    await adminPage.goto("/en/admin/audit-logs");

    // Sidebar should be hidden on mobile
    const sidebar = adminPage.locator("aside");
    await expect(sidebar).toBeHidden();

    // Mobile trigger button should be visible
    const trigger = adminPage.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(trigger).toBeVisible();

    // Click trigger to open sheet
    await trigger.click();

    // Sheet should show admin nav with Audit Log link
    const auditLink = adminPage.getByRole("link", { name: "Audit Log" }).last();
    await expect(auditLink).toBeVisible();
  });

  test("renders audit logs page with title and filter controls", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/audit-logs");

    // Title and description
    await expect(adminPage.locator("h1")).toHaveText("Audit Logs");
    await expect(
      adminPage.getByText("Search and filter system audit logs."),
    ).toBeVisible();

    // Filter controls
    await expect(adminPage.locator("select")).toBeVisible();
    await expect(
      adminPage.locator('input[placeholder="Action"]'),
    ).toBeVisible();
    await expect(
      adminPage.locator('input[placeholder="Actor ID"]'),
    ).toBeVisible();
    await expect(
      adminPage.locator('input[placeholder="Customer ID"]'),
    ).toBeVisible();
    await expect(
      adminPage.locator('input[placeholder="AICE ID"]'),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("button", { name: "Apply" }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("button", { name: "Reset" }),
    ).toBeVisible();
  });

  test("displays table with column headers", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/audit-logs");

    const table = adminPage.locator("table").first();
    await expect(table).toBeVisible();

    // Column headers (scoped to thead to avoid matching data cells)
    const header = table.locator("thead");
    await expect(header.getByText("Timestamp")).toBeVisible();
    await expect(header.getByText("Actor")).toBeVisible();
    await expect(header.getByText("Action")).toBeVisible();
    await expect(header.getByText("Target")).toBeVisible();
    await expect(header.getByText("Auth Context")).toBeVisible();
    await expect(header.getByText("IP Address")).toBeVisible();
    await expect(header.getByText("Correlation ID")).toBeVisible();
  });

  test("clicking a row expands detail view", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/audit-logs");
    await adminPage.waitForSelector("table tbody tr");

    // Click the first data row
    const firstRow = adminPage.locator("table tbody tr").first();
    await firstRow.click();

    // The details section should appear
    await expect(adminPage.getByText("Details")).toBeVisible();
  });

  test("reset button clears filter inputs", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/audit-logs");

    // Fill in a filter
    const actionInput = adminPage.locator('input[placeholder="Action"]');
    await actionInput.fill("test_action");
    await expect(actionInput).toHaveValue("test_action");

    // Click Reset
    await adminPage.getByRole("button", { name: "Reset" }).click();
    await expect(actionInput).toHaveValue("");
  });

  test("auth context dropdown has correct options", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/audit-logs");

    const select = adminPage.locator("select");
    const options = select.locator("option");

    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText("All contexts");
    await expect(options.nth(1)).toHaveText("General");
    await expect(options.nth(2)).toHaveText("Admin");
  });

  test("applying auth_context filter changes results", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/audit-logs");
    await adminPage.waitForSelector("table tbody tr");

    // Filter to admin-only
    await adminPage.locator("select").selectOption("admin");
    await adminPage.getByRole("button", { name: "Apply" }).click();

    // Wait for table to re-render
    await adminPage.waitForTimeout(500);

    // All visible auth context badges should say "Admin"
    const badges = adminPage.locator("table tbody tr td:nth-child(5)");
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toHaveText("Admin");
    }
  });

  test("correlation click clears active filters to show full group", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/audit-logs");
    await adminPage.waitForSelector("table tbody tr");

    // Apply a filter first
    await adminPage.locator("select").selectOption("admin");
    await adminPage.getByRole("button", { name: "Apply" }).click();
    await adminPage.waitForTimeout(300);

    // Click a correlation ID link
    const corrButton = adminPage
      .getByRole("button", { name: "View correlated events" })
      .first();
    const hasCorrelation = (await corrButton.count()) > 0;

    if (hasCorrelation) {
      await corrButton.click();

      // The correlation filter banner should appear
      await expect(adminPage.getByText("Correlation ID:")).toBeVisible();

      // The auth_context dropdown should be reset to "All contexts"
      await expect(adminPage.locator("select")).toHaveValue("");

      // Click clear to dismiss
      await adminPage.getByRole("button", { name: "Clear" }).click();
      await expect(adminPage.getByText("Correlation ID:")).not.toBeVisible();
    }
  });

  test("row expands even without details (shows metadata)", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/audit-logs");
    await adminPage.waitForSelector("table tbody tr");

    // Click a row — even if it has no details, the expanded section
    // should appear showing SID/customer/AICE/correlation metadata
    const firstRow = adminPage.locator("table tbody tr").first();
    await firstRow.click();

    // The expanded section should be visible (with bg-muted/20)
    const expandedCell = adminPage.locator("td.bg-muted\\/20");
    await expect(expandedCell).toBeVisible();
  });

  test("renders in Korean locale", async ({ adminPage }) => {
    await adminPage.goto("/ko/admin/audit-logs");

    await expect(adminPage.locator("h1")).toHaveText("감사 로그");
    await expect(
      adminPage.getByText("시스템 감사 로그를 검색하고 필터링합니다."),
    ).toBeVisible();

    // Korean filter labels
    const select = adminPage.locator("select");
    const options = select.locator("option");
    await expect(options.nth(0)).toHaveText("전체 컨텍스트");
  });
});
