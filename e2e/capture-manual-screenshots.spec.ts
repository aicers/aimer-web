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
 *
 * Capture density: deviceScaleFactor 0.75, so the on-disk PNG is the
 * effective resolution 960×540 (or 281×500 for the mobile case). The
 * browser re-rasterises at that density rather than down-sampling a
 * high-DPI render, which keeps Latin and Korean glyphs crisp at 1× zoom
 * in the rendered manual while halving the per-image token cost of LLM
 * vision reads. See docs/AUTHORING.md for the policy and #203 for the
 * rationale (token economics, mirroring aice-web-next/#522).
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
/**
 * Lower the rendered pixel density so the captured PNG is 960×540 rather
 * than 1280×720 (or 281×500 instead of 375×667 for the mobile case),
 * cutting per-image token cost by ~44% without shrinking the captured
 * layout. Documented in docs/AUTHORING.md and applied to every browser
 * context this spec creates (see browser.newContext calls below).
 */
const SCALE_FACTOR = 0.75;

// Declared so any future test that uses the default `page` fixture inherits
// the same density. The contexts opened explicitly via browser.newContext
// below pass the same value through their options.
base.use({ deviceScaleFactor: SCALE_FACTOR });

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
const trustRegistryKeyIds: number[] = [];

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

    // ── Trust registry keys for expires_at color signal capture (slot 5) ──
    // Four keys with distinct expiry distances cover the neutral / yellow /
    // red / gray bands in one screenshot.
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const expirySamples = [
      { kid: "capture-neutral", expiresAt: new Date(now + 60 * dayMs) },
      { kid: "capture-yellow", expiresAt: new Date(now + 15 * dayMs) },
      { kid: "capture-red", expiresAt: new Date(now + 3 * dayMs) },
      { kid: "capture-gray", expiresAt: new Date(now - 2 * dayMs) },
    ];
    for (const { kid, expiresAt } of expirySamples) {
      const res = await pool.query<{ id: number }>(
        `INSERT INTO trust_registry
           (aice_id, issuer, kid, public_key, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          testData.aiceEnvironment.aiceId,
          "https://capture.example",
          kid,
          JSON.stringify({ kty: "RSA", n: `capture-${kid}`, e: "AQAB" }),
          expiresAt,
        ],
      );
      trustRegistryKeyIds.push(res.rows[0].id);
    }

    // ── Browser contexts ──
    const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

    adminCtx = await browser.newContext({
      baseURL,
      deviceScaleFactor: SCALE_FACTOR,
    });
    await injectAuthCookies(adminCtx, testData.admin, "admin");
    adminPage = await adminCtx.newPage();
    await adminPage.setViewportSize(VIEWPORT);

    mgrCtx = await browser.newContext({
      baseURL,
      deviceScaleFactor: SCALE_FACTOR,
    });
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

    // Trust registry rows must be deleted before cleanupTestData drops
    // the aice_environments row they FK to.
    if (trustRegistryKeyIds.length > 0) {
      await pool.query("DELETE FROM trust_registry WHERE id = ANY($1)", [
        trustRegistryKeyIds,
      ]);
    }
    // Any environments/keys created via the JWK-thumbprint capture below
    // (slot 4) leave a residual aice_environments row + trust_registry row.
    // The capture uses a stable aiceId prefix so cleanup is bounded.
    await pool.query(
      "DELETE FROM trust_registry WHERE aice_id LIKE 'capture-thumbprint-%'",
    );
    await pool.query(
      "DELETE FROM aice_environments WHERE aice_id LIKE 'capture-thumbprint-%'",
    );

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
    const ctx = await browser.newContext({
      baseURL,
      deviceScaleFactor: SCALE_FACTOR,
    });
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
    const ctx = await browser.newContext({
      baseURL,
      deviceScaleFactor: SCALE_FACTOR,
    });
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

    // Wait for invitation to appear in the table
    await expect(
      mgrPage.getByRole("cell", { name: inviteEmail }),
    ).toBeVisible();
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

  // =========================================================================
  // aimer-bridge batch (issue #203) — fills the 14 placeholders left by
  // PRs #198/#200/#201/#202 across docs/{en,ko}/{authentication,environment-
  // management,customer-management,cross-system-customer-identification}.md.
  //
  // Each of the seven slots is captured once per locale (EN + KO) — the same
  // capture flow drives the app in the matching locale and the manual embeds
  // its locale-specific PNG. See #203 for the slot ↔ placeholder mapping.
  // =========================================================================

  type Locale = "en" | "ko";
  const LOCALES: readonly Locale[] = ["en", "ko"] as const;

  const LOCALE_LABELS: Record<
    Locale,
    {
      createCustomer: string;
      createEnvironment: string;
      edit: string;
      save: string;
      cancel: string;
      trustRegistryKey: RegExp;
      manageKeys: string;
      confirmExternalKeyHeading: string;
    }
  > = {
    en: {
      createCustomer: "Create Customer",
      createEnvironment: "Create Environment",
      edit: "Edit",
      save: "Save",
      cancel: "Cancel",
      trustRegistryKey: /Trust Registry Key/,
      manageKeys: "Keys",
      confirmExternalKeyHeading: "Confirm external_key change",
    },
    ko: {
      createCustomer: "고객 생성",
      createEnvironment: "환경 생성",
      edit: "편집",
      save: "저장",
      cancel: "취소",
      trustRegistryKey: /신뢰 레지스트리 키/,
      manageKeys: "키",
      confirmExternalKeyHeading: "external_key 변경 확인",
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 1 — Bridge entry from Aimer Console (#195)
  // The post-bridge-POST sign-in screen is the Keycloak login form — exactly
  // what `sign-in.png` already captures. Rather than emit a duplicate PNG,
  // docs/{en,ko}/authentication.md reuses the existing `sign-in.png` at
  // both the direct sign-in placeholder (line 14 / line 14) and the bridge
  // entry placeholder (line 46 / line 44). No new capture case is needed
  // for slot 1.
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 2 — Bridge deny page revised copy (#194)
  // Captures the deny page for a bridge-customer-mismatch — one of the
  // bridge-specific deny reasons #194 introduced. The reason chosen renders
  // the longest copy block, giving the manual the most representative shot.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(`auth-bridge-deny.${locale}.png`, async ({ browser }) => {
      const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
      const ctx = await browser.newContext({
        baseURL,
        deviceScaleFactor: SCALE_FACTOR,
      });
      const page = await ctx.newPage();
      await page.setViewportSize(VIEWPORT);
      try {
        await page.goto(`/${locale}/deny?reason=bridge_customer_mismatch`);
        await expect(page.locator("h1")).toBeVisible();
        await page.screenshot({
          path: resolve(ASSETS, `auth-bridge-deny.${locale}.png`),
        });
      } finally {
        await ctx.close();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 3 — Key expiration policy surfacing (#193)
  // Captures the deny page for a bridge-expired sign-in attempt, which is
  // the user-visible surface of an expired trust_registry key.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(`auth-bridge-key-expired.${locale}.png`, async ({ browser }) => {
      const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
      const ctx = await browser.newContext({
        baseURL,
        deviceScaleFactor: SCALE_FACTOR,
      });
      const page = await ctx.newPage();
      await page.setViewportSize(VIEWPORT);
      try {
        await page.goto(`/${locale}/deny?reason=bridge_expired`);
        await expect(page.locator("h1")).toBeVisible();
        await page.screenshot({
          path: resolve(ASSETS, `auth-bridge-key-expired.${locale}.png`),
        });
      } finally {
        await ctx.close();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 4 — JWK Thumbprint confirm flow (#192)
  // Opens the Create Environment dialog, fills the basic fields, enables the
  // Trust Registry Key sub-form, pastes a valid JWK, and waits for the
  // server-computed thumbprint to render in both base64url and colon-hex
  // formats. The confirm checkbox is left UNTOGGLED so the disabled-submit
  // state — the central #192 affordance — is visible in the shot. The
  // dialog is then cancelled without persisting anything.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(`admin-environments-thumbprint-confirm.${locale}.png`, async () => {
      const labels = LOCALE_LABELS[locale];
      const aiceId = `capture-thumbprint-${locale}-${randomUUID().slice(0, 8)}`;
      const jwk = {
        kty: "RSA",
        n: `capture-jwk-${locale}-${randomUUID().slice(0, 12)}`,
        e: "AQAB",
      };

      // The Create Environment dialog with the trust-registry sub-form
      // checked is taller than the standard 720 px viewport — including
      // both thumbprint formats (base64url + hex) and the confirm checkbox
      // + Submit button — the central affordance of slot 4 — runs roughly
      // 1200 px tall. Bump viewport height for this capture only; width
      // is unchanged so layout flow stays identical to what users see at
      // 1280×720. (Radix DialogContent caps height at 85vh, so the
      // viewport must be at least ~1400 px for the dialog to fit fully.)
      // The mobile-menu capture above sets the same precedent for
      // per-shot viewport overrides.
      await adminPage.setViewportSize({ width: 1280, height: 1400 });

      await adminPage.goto(`/${locale}/admin/environments`);
      await settle(adminPage);
      await adminPage
        .getByRole("button", { name: labels.createEnvironment })
        .first()
        .click();
      await adminPage.locator("#env-aice-id").fill(aiceId);
      await adminPage.locator("#env-name").fill(`Capture ${aiceId}`);
      await adminPage
        .getByRole("checkbox", { name: labels.trustRegistryKey })
        .check();
      await adminPage.locator("#env-issuer").fill("https://capture.example");
      await adminPage.locator("#env-kid").fill("capture-key");
      await adminPage
        .locator("#env-public-key")
        .fill(JSON.stringify(jwk, null, 2));

      // Wait for the server-computed thumbprint to render — the dialog
      // includes a 43-char base64url block once /api/admin/trust-registry/
      // thumbprint resolves.
      await expect(
        adminPage.locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ }).first(),
      ).toBeVisible();

      await adminPage.screenshot({
        path: resolve(
          ASSETS,
          `admin-environments-thumbprint-confirm.${locale}.png`,
        ),
      });

      // Cancel without submitting — the thumbprint capture must not leave
      // a residual environment behind.
      await adminPage.keyboard.press("Escape");
      await adminPage.setViewportSize(VIEWPORT);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 5 — `expires_at` per-key row + color signals (#193)
  // Opens the seeded environment's detail panel on the Keys tab, where the
  // four trust_registry rows seeded in beforeAll (neutral / yellow / red /
  // gray) render in one table. Captures the keys table area only.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(`admin-environments-expires-row.${locale}.png`, async () => {
      await adminPage.goto(`/${locale}/admin/environments`);
      await settle(adminPage);
      await adminPage.waitForSelector("table tbody tr");

      // The detail panel opens via the per-row keyCount button (the digit
      // rendered in the "Keys" column), not via a row click. The button
      // also pre-selects the Keys tab — exactly what we want to capture.
      // We seeded 4 trust_registry rows in beforeAll, so the button text
      // is the digit 4 within the row matched by environment name.
      const row = adminPage.locator("tbody tr", {
        hasText: testData.aiceEnvironment.name,
      });
      await row.first().getByRole("button", { name: "4", exact: true }).click();

      // Detail panel is rendered below the table once a row is opened.
      // Wait for the seeded keys to appear in the keys list.
      await expect(adminPage.getByText(/capture-yellow/)).toBeVisible();
      await expect(adminPage.getByText(/capture-gray/)).toBeVisible();

      // Capture full page so the detail panel + colored rows are included
      // even when they sit below the initial viewport fold.
      await adminPage.screenshot({
        path: resolve(ASSETS, `admin-environments-expires-row.${locale}.png`),
        fullPage: true,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 6 — Customer edit dialog + external_key change warning (#196)
  // Opens the seeded customer's Edit dialog, changes external_key, clicks
  // Save, and captures the non-dismissable warning modal that intercepts
  // the save. The change is then cancelled.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(`admin-customers-edit-warning.${locale}.png`, async () => {
      const labels = LOCALE_LABELS[locale];

      await adminPage.goto(`/${locale}/admin/customers`);
      await settle(adminPage);
      await adminPage.waitForSelector("table tbody tr");

      const row = adminPage.locator("tbody tr", {
        hasText: testData.customer.name,
      });
      await row.getByRole("button", { name: labels.edit }).click();

      const keyInput = adminPage.locator("#customer-edit-external-key");
      await keyInput.fill(`${testData.customer.externalKey}-capture`);

      await adminPage.getByRole("button", { name: labels.save }).click();
      await expect(
        adminPage.getByRole("heading", {
          name: labels.confirmExternalKeyHeading,
        }),
      ).toBeVisible();

      await adminPage.screenshot({
        path: resolve(ASSETS, `admin-customers-edit-warning.${locale}.png`),
      });

      // Cancel out so the PATCH does not fire and the seeded customer is
      // returned to its original external_key for later captures / cleanup.
      // Target the Cancel button explicitly — the warning dialog also has
      // a "Yes, change external_key" confirm button last in DOM order, so
      // a `.last()` shortcut would confirm rather than cancel and mutate
      // the customer's external_key for the subsequent locale's capture.
      const warningDialog = adminPage
        .locator('[role="dialog"]')
        .filter({ hasText: labels.confirmExternalKeyHeading });
      await warningDialog.getByRole("button", { name: labels.cancel }).click();
      await adminPage.keyboard.press("Escape");
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slot 7 — Cross-system identification operator guide hero (#196)
  // The hero on docs/{en,ko}/cross-system-customer-identification.md. Uses
  // the Create Customer dialog, where the external_key field surfaces the
  // inline help block + the link to this very operations guide — the
  // closest in-app surface to what the guide documents.
  // ─────────────────────────────────────────────────────────────────────────

  for (const locale of LOCALES) {
    base(
      `cross-system-customer-identification-hero.${locale}.png`,
      async () => {
        const labels = LOCALE_LABELS[locale];

        await adminPage.goto(`/${locale}/admin/customers`);
        await settle(adminPage);
        await adminPage
          .getByRole("button", { name: labels.createCustomer })
          .click();

        const help = adminPage.locator("#customer-external-key-help");
        await expect(help).toBeVisible();

        await adminPage.screenshot({
          path: resolve(
            ASSETS,
            `cross-system-customer-identification-hero.${locale}.png`,
          ),
        });

        await adminPage.keyboard.press("Escape");
      },
    );
  }

  // =========================================================================
  // Analysis result page (issue #308) — split priority badge + severity /
  // likelihood scores. The page route is per-customer, so the capture
  // provisions a customer DB for the seeded `testData.customer.id`, runs
  // customer migrations on it, and inserts a `detection_events` +
  // `event_analysis_result` pair so the loader returns a populated row.
  // No `event_redaction_map` row is created — the loader falls back to
  // the raw `analysis_text`, which keeps the capture independent of
  // OpenBao Transit availability.
  // =========================================================================

  const ANALYSIS_EVENT_KEY = "1";
  const ANALYSIS_MODEL_NAME = "openai";
  const ANALYSIS_MODEL = "gpt-4o";
  // Severity 0.82, likelihood 0.71 ⇒ CRITICAL via the RFC 0002 4×4
  // matrix (severity ≥ 0.8, 0.6 ≤ likelihood < 0.8). Picked so the
  // screenshot shows the most visually distinct tier badge — the
  // rose-coloured CRITICAL pill — and a non-trivial pair of axis
  // numerics (0.820 / 0.710) rather than rounded edge cases that
  // could mislead readers about how the matrix actually maps.
  const ANALYSIS_SEVERITY = 0.82;
  const ANALYSIS_LIKELIHOOD = 0.71;
  const ANALYSIS_TIER = "CRITICAL";

  function customerOwnerUrl(customerId: string): string {
    const tpl =
      process.env.CUSTOMER_DATABASE_OWNER_URL ??
      "postgres://aimer_customer_owner:changeme@localhost:5432/template1";
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    return tpl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  }

  async function provisionAnalysisCustomerDb(
    customerId: string,
  ): Promise<void> {
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    const adminUrl =
      process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "";
    if (!adminUrl) {
      throw new Error(
        "DATABASE_ADMIN_URL or DATABASE_URL must be set to provision the " +
          "analysis-result capture customer DB",
      );
    }
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      const exists = await adminPool.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = $1",
        [dbName],
      );
      if (exists.rows.length === 0) {
        await adminPool.query(
          `CREATE DATABASE ${dbName} OWNER aimer_customer_owner`,
        );
      }
    } finally {
      await adminPool.end();
    }

    const ownerUrl = customerOwnerUrl(customerId);
    const ownerPool = new Pool({ connectionString: ownerUrl });
    try {
      // Mirror provisionCustomerDb's role-grant step so the runtime
      // `aimer_customer` connection (used by the page's loader) can
      // reach the schema. Idempotent — re-running the capture is safe.
      await ownerPool.query("GRANT USAGE ON SCHEMA public TO aimer_customer");
      await ownerPool.query(
        `GRANT CONNECT ON DATABASE ${dbName} TO aimer_customer`,
      );
    } finally {
      await ownerPool.end();
    }

    // Run the customer migration set on a fresh pool. All customer
    // migrations are plain SQL files (no DML/TS migrations exist for
    // this DB), so a small inlined runner is sufficient — Playwright
    // bundles this spec as CJS and cannot dynamically import the
    // TypeScript `src/lib/db/migrate.ts` source at runtime.
    const migrationOwnerPool = new Pool({ connectionString: ownerUrl });
    try {
      await runCustomerMigrations(
        migrationOwnerPool,
        resolve(process.cwd(), "migrations", "customer"),
      );
    } finally {
      await migrationOwnerPool.end();
    }
  }

  async function runCustomerMigrations(
    pool: import("pg").Pool,
    dir: string,
  ): Promise<void> {
    const { readdir, readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");

    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          version    TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const applied = new Map<string, string>();
      const rows = await client.query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM _migrations",
      );
      for (const row of rows.rows) applied.set(row.version, row.checksum);

      const entries = (await readdir(dir))
        .filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f))
        .sort();

      for (const file of entries) {
        const match = file.match(/^(\d{4}[a-z]?)_(.+)\.sql$/);
        if (!match) continue;
        const [, version, name] = match;
        const content = await readFile(resolve(dir, file), "utf-8");
        const checksum = createHash("sha256").update(content).digest("hex");
        if (applied.has(version)) continue;

        const noTx = content.includes("-- no-transaction");
        if (noTx) {
          await client.query(content);
        } else {
          await client.query("BEGIN");
          try {
            await client.query(content);
            await client.query(
              "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
              [version, name, checksum],
            );
            await client.query("COMMIT");
            continue;
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        }
        await client.query(
          "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [version, name, checksum],
        );
      }
    } finally {
      client.release();
    }
  }

  async function seedAnalysisRow(customerId: string): Promise<void> {
    const ownerUrl = customerOwnerUrl(customerId);
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: ownerUrl });
    try {
      await pool.query(
        `INSERT INTO detection_events
           (aice_id, event_key, redacted_event, redaction_policy_version,
            schema_version, payload_hash, source, ingested_by)
         VALUES ($1, $2::numeric, '{}'::jsonb, 'engine:0.0.0|ranges:none',
                 '0.0.0', '0', 'manual', $3)
         ON CONFLICT (aice_id, event_key) DO NOTHING`,
        [
          testData.aiceEnvironment.aiceId,
          ANALYSIS_EVENT_KEY,
          testData.manager.accountId,
        ],
      );
      await pool.query(
        `INSERT INTO event_analysis_result
           (aice_id, event_key, lang, model_name, model,
            model_actual_version, prompt_version,
            severity_score, likelihood_score, priority_tier,
            analysis_text, redaction_policy_version, requested_by)
         VALUES ($1, $2::numeric, 'ENGLISH', $3, $4,
                 'gpt-4o-2024-08-06', 'aimer-prompt-v3',
                 $5, $6, $7,
                 $8, 'engine:0.0.0|ranges:none', $9)
         ON CONFLICT (aice_id, event_key, lang, model_name, model)
         DO UPDATE SET
           severity_score   = EXCLUDED.severity_score,
           likelihood_score = EXCLUDED.likelihood_score,
           priority_tier    = EXCLUDED.priority_tier,
           analysis_text    = EXCLUDED.analysis_text`,
        [
          testData.aiceEnvironment.aiceId,
          ANALYSIS_EVENT_KEY,
          ANALYSIS_MODEL_NAME,
          ANALYSIS_MODEL,
          ANALYSIS_SEVERITY,
          ANALYSIS_LIKELIHOOD,
          ANALYSIS_TIER,
          // A concise sample so the screenshot is dominated by the
          // header (badge + scores + metadata) rather than the body
          // text. Two short paragraphs keep the body section non-empty
          // so the visual hierarchy of the page is faithfully captured.
          "The source host attempted credential stuffing against the " +
            "/login endpoint with 412 failed attempts in 60 seconds, " +
            "matching the brute-force baseline for this aice.\n\n" +
            "Recommended action: review session anomalies on the source " +
            "account and enable per-IP rate limiting at the edge.",
          testData.manager.accountId,
        ],
      );
    } finally {
      await pool.end();
    }
  }

  async function dropAnalysisCustomerDb(customerId: string): Promise<void> {
    const dbName = `customer_${customerId.replace(/-/g, "")}`;
    const adminUrl =
      process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "";
    if (!adminUrl) return;
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await adminPool.end();
    }
  }

  for (const locale of LOCALES) {
    base(`analysis-result.${locale}.png`, async () => {
      // Provision + seed are idempotent and re-running cleans up after
      // itself in afterAll. Running them per-locale (rather than once
      // in beforeAll) keeps the capture self-contained and lets a
      // single-shot rerun of either locale work standalone.
      await provisionAnalysisCustomerDb(testData.customer.id);
      await seedAnalysisRow(testData.customer.id);

      const url =
        `/${locale}/customers/${testData.customer.id}` +
        `/aice/${testData.aiceEnvironment.aiceId}` +
        `/events/${ANALYSIS_EVENT_KEY}/analysis` +
        `?lang=ENGLISH&model_name=${ANALYSIS_MODEL_NAME}` +
        `&model=${ANALYSIS_MODEL}`;
      await mgrPage.goto(url);
      await settle(mgrPage);
      await expect(
        mgrPage.locator('[data-testid="priority-tier-badge"]'),
      ).toBeVisible();

      await mgrPage.screenshot({
        path: resolve(ASSETS, `analysis-result.${locale}.png`),
        fullPage: true,
      });
    });
  }

  base("analysis-result cleanup", async () => {
    // Captures above leave the per-customer DB behind so subsequent
    // reruns are cheap; explicit cleanup here means a fresh capture
    // pass (e.g. CI) always starts from a clean slate. This runs last
    // because the suite is `describe.serial` and tests are ordered by
    // declaration.
    await dropAnalysisCustomerDb(testData.customer.id);
  });
});
