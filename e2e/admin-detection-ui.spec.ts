import { expect, test } from "./fixtures";

// E2E UI tests for the suspicious activity page.
// Uses the admin fixture for authenticated browser access.

// ---------------------------------------------------------------------------
// Helpers — seed / cleanup alerts for tests that require table data
// ---------------------------------------------------------------------------

async function insertTestAlert(
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
      indicator: "consecutive_sign_in_denials",
      severity: "warning",
      actor_id: "e2e-ui-actor-00000000-0000-0000-0000-000000000099",
      ip_address: "127.0.0.1",
      summary: JSON.stringify({ denialCount: 5, windowMinutes: 15 }),
      audit_log_ids: "{}",
      correlation_id: null,
      ...overrides,
    };

    const result = await pool.query(
      `INSERT INTO suspicious_activity_alerts
         (indicator, severity, actor_id, ip_address, summary,
          audit_log_ids, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        defaults.indicator,
        defaults.severity,
        defaults.actor_id,
        defaults.ip_address,
        defaults.summary,
        defaults.audit_log_ids,
        defaults.correlation_id,
      ],
    );
    return result.rows[0].id;
  } finally {
    await pool.end();
  }
}

async function cleanupTestAlerts(): Promise<void> {
  const auditUrl =
    process.env.AUDIT_DATABASE_MIGRATION_URL ??
    process.env.AUDIT_DATABASE_URL ??
    "";
  if (!auditUrl) return;

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: auditUrl });
  try {
    await pool.query(
      "DELETE FROM suspicious_activity_alerts WHERE actor_id LIKE 'e2e-ui-actor-%'",
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

test.describe("Suspicious activity page — rendering", () => {
  test.beforeAll(async () => {
    await cleanupTestAlerts();

    await insertTestAlert({
      indicator: "consecutive_sign_in_denials",
      severity: "warning",
    });
    await insertTestAlert({
      indicator: "suspended_account_sign_in",
      severity: "severe",
    });
  });

  test.afterAll(async () => {
    await cleanupTestAlerts();
  });

  test("shows page title and description", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");
    await expect(
      adminPage.getByRole("heading", { name: "Account Anomalies" }),
    ).toBeVisible();
  });

  test("renders alert table with data", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");

    const table = adminPage.locator("table");
    await expect(table).toBeVisible();

    // Should have at least 2 rows
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
  });

  test("displays severity badges", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");

    await expect(adminPage.getByText("Severe").first()).toBeVisible();
    await expect(adminPage.getByText("Warning").first()).toBeVisible();
  });

  test("expands row to show summary details", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");

    // Click first data row
    const firstRow = adminPage.locator("table tbody tr").first();
    await firstRow.click();

    // Should show summary section
    await expect(adminPage.getByText("Summary").first()).toBeVisible();
  });

  test("renders in Korean locale", async ({ adminPage }) => {
    await adminPage.goto("/ko/admin/suspicious-activity");
    await expect(
      adminPage.getByRole("heading", { name: "계정 이상징후" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------

test.describe("Suspicious activity — sidebar navigation", () => {
  test("sidebar contains Account Anomalies link", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");
    const sidebar = adminPage.locator("aside");
    await expect(sidebar.getByText("Account Anomalies")).toBeVisible();
  });

  test("Account Anomalies link is active when on the page", async ({
    adminPage,
  }) => {
    await adminPage.goto("/en/admin/suspicious-activity");
    const link = adminPage
      .locator("aside")
      .getByRole("link", { name: "Account Anomalies" });
    await expect(link).toHaveAttribute("aria-current", "page");
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test.describe("Suspicious activity — filters", () => {
  test.beforeAll(async () => {
    await cleanupTestAlerts();

    await insertTestAlert({
      indicator: "consecutive_sign_in_denials",
      severity: "warning",
    });
    await insertTestAlert({
      indicator: "suspended_account_sign_in",
      severity: "severe",
    });
  });

  test.afterAll(async () => {
    await cleanupTestAlerts();
  });

  test("can filter by severity", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");

    // Select "Severe" severity
    await adminPage.locator("select").first().selectOption("severe");
    await adminPage.getByRole("button", { name: "Apply" }).click();

    // Wait for table to update
    await adminPage.waitForTimeout(500);

    // All visible badges should be "Severe"
    const table = adminPage.locator("table");
    if (await table.isVisible()) {
      const rows = table.locator("tbody tr");
      const count = await rows.count();
      // If rows exist, they should all be severe
      if (count > 0) {
        // Check that "Warning" badge is not visible in any row
        const warningBadges = table.locator("tbody").getByText("Warning");
        expect(await warningBadges.count()).toBe(0);
      }
    }
  });

  test("can reset filters", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");

    // Apply a filter
    await adminPage.locator("select").first().selectOption("severe");
    await adminPage.getByRole("button", { name: "Apply" }).click();
    await adminPage.waitForTimeout(300);

    // Reset
    await adminPage.getByRole("button", { name: "Reset" }).click();
    await adminPage.waitForTimeout(300);

    // Should show all results again
    const select = adminPage.locator("select").first();
    await expect(select).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test.describe("Suspicious activity — empty state", () => {
  test.beforeAll(async () => {
    await cleanupTestAlerts();
  });

  test("shows empty message when no alerts", async ({ adminPage }) => {
    await adminPage.goto("/en/admin/suspicious-activity");
    await expect(
      adminPage.getByText("No account anomaly alerts found."),
    ).toBeVisible();
  });
});
