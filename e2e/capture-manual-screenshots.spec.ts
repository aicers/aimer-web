/**
 * Capture all 25 manual screenshots in a single session.
 *
 * Run:
 *   pnpm playwright test e2e/capture-manual-screenshots.spec.ts
 *
 * Prerequisites:
 *   - Docker Compose dev stack running (postgres, keycloak, openbao, mailpit)
 *   - Migrations applied
 *   - Dev server running (or Playwright will start one via webServer config)
 *   - .env configured with DATABASE_MIGRATION_URL, CSRF_SECRET, etc.
 *
 * All screenshots share a single seeded dataset so E2E user names are
 * consistent across every page in the manual.
 *
 * Viewport: 1280×720 for all shots except `mobile-menu.png` (375×667)
 * because the mobile navigation menu is only visible at narrow widths.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import { injectAuthCookies } from "./fixtures/auth";
import {
  cleanupTestData,
  closePool,
  getTestPool,
  seedTestData,
  type TestData,
} from "./fixtures/db";
import { loadEnv } from "./fixtures/env";

loadEnv();

const ASSETS = resolve(process.cwd(), "docs/assets");
const VIEWPORT = { width: 1280, height: 720 };

/** Remove the Next.js dev overlay so it does not cover UI elements. */
async function removeOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("nextjs-portal")) el.remove();
  });
}

/** Wait for the page to settle after navigation. */
async function settle(page: Page): Promise<void> {
  await removeOverlay(page);
  // Allow any loading spinners / transitions to complete
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Shared state across all tests (seeded once, cleaned up once)
// ---------------------------------------------------------------------------

let testData: TestData;
let extraAdminId: string;
const auditLogIds: number[] = [];

let adminCtx: BrowserContext;
let adminPage: Page;
let mgrCtx: BrowserContext;
let mgrPage: Page;

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

base.describe.serial("Manual screenshots", () => {
  base.beforeAll(async ({ browser }) => {
    testData = await seedTestData();
    const pool = getTestPool();

    // ── Extra admin-eligible account (for revoke dialog) ──
    extraAdminId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await pool.query(
      `INSERT INTO accounts
         (id, oidc_issuer, oidc_subject, username, display_name, email, status, admin_eligible)
       VALUES ($1, 'e2e-issuer', $2, $3, $4, $5, 'active', true)`,
      [
        extraAdminId,
        `extra-admin-${suffix}`,
        `extra-admin-${suffix}`,
        `E2E Manager ${testData.customer.externalKey.slice(4)}`,
        `mgr-${testData.customer.externalKey.slice(4)}@e2e.test`,
      ],
    );

    // ── Audit log entries ──
    const auditUrl =
      process.env.AUDIT_DATABASE_MIGRATION_URL ??
      process.env.AUDIT_DATABASE_URL;
    if (!auditUrl) {
      throw new Error(
        "AUDIT_DATABASE_MIGRATION_URL or AUDIT_DATABASE_URL must be set " +
          "to seed audit log entries for screenshots",
      );
    }
    const { Pool } = await import("pg");
    const auditPool = new Pool({ connectionString: auditUrl });
    try {
      for (const action of [
        "session.created",
        "admin.designate",
        "session.ip_changed",
        "admin.customer_created",
        "admin.environment_created",
      ]) {
        const res = await auditPool.query(
          `INSERT INTO audit_logs
             (actor_id, auth_context, action, target_type, details, ip_address)
           VALUES ($1, 'admin', $2, 'account', '{"screenshot": true}', '192.168.1.1')
           RETURNING id`,
          [testData.admin.accountId, action],
        );
        auditLogIds.push(res.rows[0].id);
      }
    } finally {
      await auditPool.end();
    }

    // ── Browser contexts ──
    const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

    adminCtx = await browser.newContext({ baseURL });
    await injectAuthCookies(adminCtx, testData.admin, "admin");
    adminPage = await adminCtx.newPage();
    await adminPage.setViewportSize(VIEWPORT);

    mgrCtx = await browser.newContext({ baseURL });
    await injectAuthCookies(mgrCtx, testData.manager, "general");
    mgrPage = await mgrCtx.newPage();
    await mgrPage.setViewportSize(VIEWPORT);
  });

  base.afterAll(async () => {
    await adminCtx?.close();
    await mgrCtx?.close();

    // Clean up extra admin account
    const pool = getTestPool();
    await pool.query("DELETE FROM accounts WHERE id = $1", [extraAdminId]);

    // Clean up audit logs (env var validated in beforeAll)
    if (auditLogIds.length > 0) {
      const auditUrl =
        process.env.AUDIT_DATABASE_MIGRATION_URL ??
        process.env.AUDIT_DATABASE_URL ??
        "";
      const { Pool } = await import("pg");
      const auditPool = new Pool({ connectionString: auditUrl });
      try {
        await auditPool.query("DELETE FROM audit_logs WHERE id = ANY($1)", [
          auditLogIds,
        ]);
      } finally {
        await auditPool.end();
      }
    }

    await cleanupTestData(testData);
    await closePool();
  });

  // =========================================================================
  // Authentication — docs/{en,ko}/authentication.md
  // =========================================================================

  base("sign-in.png", async ({ browser }) => {
    // The sign-in page is the Keycloak login form. Navigate to the
    // auth redirect endpoint which sends the browser to Keycloak.
    const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);

    try {
      await page.goto("/api/auth/sign-in", {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      await page.screenshot({ path: resolve(ASSETS, "sign-in.png") });
    } finally {
      await ctx.close();
    }
  });

  base("sign-out-header.png", async () => {
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Open the user profile dropdown
    await mgrPage.getByText(testData.manager.displayName).click();
    await expect(mgrPage.getByText("Sign Out")).toBeVisible();

    // Crop to the dropdown region in the top-right corner
    const trigger = mgrPage.getByText(testData.manager.displayName).first();
    const box = await trigger.boundingBox();
    if (!box) throw new Error("Could not locate user dropdown trigger");

    const clipX = Math.max(0, box.x - 200);
    await mgrPage.screenshot({
      path: resolve(ASSETS, "sign-out-header.png"),
      clip: { x: clipX, y: 0, width: 576, height: 180 },
    });

    // Close dropdown by pressing Escape
    await mgrPage.keyboard.press("Escape");
  });

  base("deny-page.png", async ({ browser }) => {
    const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);

    try {
      await page.goto("/en/deny?reason=no_access");
      await expect(page.locator("h1")).toContainText("Access Denied");
      await page.screenshot({ path: resolve(ASSETS, "deny-page.png") });
    } finally {
      await ctx.close();
    }
  });

  // =========================================================================
  // Navigation — docs/{en,ko}/navigation.md
  // =========================================================================

  base("header-bar.png", async () => {
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Capture just the header strip (full width, ~64px tall)
    await mgrPage.screenshot({
      path: resolve(ASSETS, "header-bar.png"),
      clip: { x: 0, y: 0, width: 1280, height: 64 },
    });
  });

  base("sidebar-expanded.png", async () => {
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Ensure sidebar is expanded
    const collapseBtn = mgrPage.getByRole("button", {
      name: "Collapse sidebar",
    });
    if (!(await collapseBtn.isVisible())) {
      await mgrPage.getByRole("button", { name: "Expand sidebar" }).click();
      await mgrPage.waitForTimeout(300);
    }

    await mgrPage.screenshot({
      path: resolve(ASSETS, "sidebar-expanded.png"),
    });
  });

  base("sidebar-collapsed.png", async () => {
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Collapse sidebar
    await mgrPage.getByRole("button", { name: "Collapse sidebar" }).click();
    await mgrPage.waitForTimeout(300);

    await mgrPage.screenshot({
      path: resolve(ASSETS, "sidebar-collapsed.png"),
    });

    // Re-expand for subsequent screenshots
    await mgrPage.getByRole("button", { name: "Expand sidebar" }).click();
    await mgrPage.waitForTimeout(300);
  });

  base("customer-selector.png", async () => {
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Capture just the sidebar area showing the customer/environment selectors
    await mgrPage.screenshot({
      path: resolve(ASSETS, "customer-selector.png"),
      clip: { x: 0, y: 30, width: 256, height: 656 },
    });
  });

  base("mobile-menu.png", async () => {
    // Exception: 375×667 viewport — the mobile menu is only visible at
    // narrow widths so it cannot be captured at the standard 1280×720.
    await mgrPage.setViewportSize({ width: 375, height: 667 });
    await mgrPage.goto("/en");
    await settle(mgrPage);

    // Open mobile navigation sheet
    const menuBtn = mgrPage.getByRole("button", {
      name: "Open navigation menu",
    });
    await menuBtn.click();
    await mgrPage.waitForTimeout(300);

    await mgrPage.screenshot({
      path: resolve(ASSETS, "mobile-menu.png"),
    });

    // Close menu and restore viewport
    await mgrPage.keyboard.press("Escape");
    await mgrPage.setViewportSize(VIEWPORT);
  });

  // =========================================================================
  // Members — docs/{en,ko}/members.md
  // =========================================================================

  base("members-table.png", async () => {
    await mgrPage.goto("/en/settings/members");
    await settle(mgrPage);
    await expect(
      mgrPage.getByRole("heading", { name: "Members", level: 1 }),
    ).toBeVisible();

    await mgrPage.screenshot({
      path: resolve(ASSETS, "members-table.png"),
    });
  });

  base("invite-dialog.png", async () => {
    await mgrPage.goto("/en/settings/members");
    await settle(mgrPage);

    await mgrPage.getByRole("button", { name: "Invite Member" }).click();
    await expect(
      mgrPage.getByRole("heading", { name: "Invite Member" }),
    ).toBeVisible();

    await mgrPage.screenshot({
      path: resolve(ASSETS, "invite-dialog.png"),
    });

    // Close dialog
    await mgrPage.getByRole("button", { name: "Cancel" }).click();
  });

  base("pending-invitations.png", async () => {
    await mgrPage.goto("/en/settings/members");
    await settle(mgrPage);

    // Send an invitation to create pending state
    await mgrPage.getByRole("button", { name: "Invite Member" }).click();
    const inviteEmail = `invite-cards@e2e.test`;
    await mgrPage.getByLabel("Email address").fill(inviteEmail);
    await mgrPage.getByRole("button", { name: "Send Invitation" }).click();

    // Wait for invitation to appear
    await expect(mgrPage.getByText(inviteEmail)).toBeVisible();
    await settle(mgrPage);

    await mgrPage.screenshot({
      path: resolve(ASSETS, "pending-invitations.png"),
    });
  });

  // =========================================================================
  // Account management — docs/{en,ko}/account-management.md
  // =========================================================================

  base("admin-accounts-table.png", async () => {
    await adminPage.goto("/en/admin/accounts");
    await settle(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: "Accounts", level: 1 }),
    ).toBeVisible();

    // Wait for table data to load
    await adminPage.waitForSelector("table tbody tr");

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-accounts-table.png"),
    });
  });

  base("admin-accounts-suspend-dialog.png", async () => {
    await adminPage.goto("/en/admin/accounts");
    await settle(adminPage);
    await adminPage.waitForSelector("table tbody tr");

    // Click Suspend on the first available non-self row
    const suspendBtn = adminPage
      .getByRole("button", { name: "Suspend" })
      .first();
    await suspendBtn.click();

    await expect(
      adminPage.getByRole("heading", { name: "Suspend Account" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-accounts-suspend-dialog.png"),
    });

    // Cancel
    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  // =========================================================================
  // Admin designation — docs/{en,ko}/admin-designation.md
  // =========================================================================

  base("admin-admins-table.png", async () => {
    await adminPage.goto("/en/admin/admins");
    await settle(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: "System Admins", level: 1 }),
    ).toBeVisible();

    await adminPage.waitForSelector("table tbody tr");

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-admins-table.png"),
    });
  });

  base("admin-admins-designate-dialog.png", async () => {
    await adminPage.goto("/en/admin/admins");
    await settle(adminPage);

    await adminPage.getByRole("button", { name: "Designate Admin" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Designate System Admin" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-admins-designate-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  base("admin-admins-revoke-dialog.png", async () => {
    await adminPage.goto("/en/admin/admins");
    await settle(adminPage);

    // Click Revoke on the extra admin row (not the current admin)
    const revokeBtn = adminPage.getByRole("button", { name: "Revoke" }).first();
    await revokeBtn.click();

    await expect(
      adminPage.getByRole("heading", { name: "Revoke System Admin" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-admins-revoke-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  // =========================================================================
  // Customer management — docs/{en,ko}/customer-management.md
  // =========================================================================

  base("admin-customers-table.png", async () => {
    await adminPage.goto("/en/admin/customers");
    await settle(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: "Customers", level: 1 }),
    ).toBeVisible();

    await adminPage.waitForSelector("table tbody tr");

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-customers-table.png"),
    });
  });

  base("admin-customers-create-dialog.png", async () => {
    await adminPage.goto("/en/admin/customers");
    await settle(adminPage);

    await adminPage.getByRole("button", { name: "Create Customer" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Create Customer" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-customers-create-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  base("admin-customers-delete-dialog.png", async () => {
    await adminPage.goto("/en/admin/customers");
    await settle(adminPage);
    await adminPage.waitForSelector("table tbody tr");

    await adminPage.getByRole("button", { name: "Delete" }).first().click();
    await expect(
      adminPage.getByRole("heading", { name: "Delete Customer" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-customers-delete-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  // =========================================================================
  // Environment management — docs/{en,ko}/environment-management.md
  // =========================================================================

  base("admin-environments-table.png", async () => {
    await adminPage.goto("/en/admin/environments");
    await settle(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: "Environments", level: 1 }),
    ).toBeVisible();

    await adminPage.waitForSelector("table tbody tr");

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-environments-table.png"),
    });
  });

  base("admin-environments-create-dialog.png", async () => {
    await adminPage.goto("/en/admin/environments");
    await settle(adminPage);

    await adminPage.getByRole("button", { name: "Create Environment" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Create Environment" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-environments-create-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  base("admin-environments-delete-dialog.png", async () => {
    await adminPage.goto("/en/admin/environments");
    await settle(adminPage);
    await adminPage.waitForSelector("table tbody tr");

    await adminPage.getByRole("button", { name: "Delete" }).first().click();
    await expect(
      adminPage.getByRole("heading", { name: "Delete Environment" }),
    ).toBeVisible();

    await adminPage.screenshot({
      path: resolve(ASSETS, "admin-environments-delete-dialog.png"),
    });

    await adminPage.getByRole("button", { name: "Cancel" }).click();
  });

  // =========================================================================
  // Audit logs — docs/{en,ko}/audit-logs.md
  // =========================================================================

  base("audit-logs-viewer.png", async () => {
    await adminPage.goto("/en/admin/audit-logs");
    await settle(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: "Audit Logs", level: 1 }),
    ).toBeVisible();

    await adminPage.waitForSelector("table tbody tr");

    await adminPage.screenshot({
      path: resolve(ASSETS, "audit-logs-viewer.png"),
    });
  });

  base("audit-logs-filters.png", async () => {
    await adminPage.goto("/en/admin/audit-logs");
    await settle(adminPage);
    await adminPage.waitForSelector("table tbody tr");

    // Select an auth context filter to show the filter panel in use
    await adminPage.locator("select").selectOption("admin");
    await adminPage.getByRole("button", { name: "Apply" }).click();
    await adminPage.waitForTimeout(500);

    await adminPage.screenshot({
      path: resolve(ASSETS, "audit-logs-filters.png"),
    });

    // Reset filters
    await adminPage.getByRole("button", { name: "Reset" }).click();
  });

  base("audit-logs-details.png", async () => {
    await adminPage.goto("/en/admin/audit-logs");
    await settle(adminPage);
    await adminPage.waitForSelector("table tbody tr");

    // Click first row to expand details
    await adminPage.locator("table tbody tr").first().click();
    await expect(adminPage.getByText("Details")).toBeVisible();
    await adminPage.waitForTimeout(300);

    await adminPage.screenshot({
      path: resolve(ASSETS, "audit-logs-details.png"),
    });
  });
});
