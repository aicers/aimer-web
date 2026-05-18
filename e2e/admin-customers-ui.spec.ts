import { Pool } from "pg";
import { expect, test } from "./fixtures";

async function openAuditPool(): Promise<Pool> {
  const url =
    process.env.AUDIT_DATABASE_MIGRATION_URL ?? process.env.AUDIT_DATABASE_URL;
  if (!url) throw new Error("AUDIT_DATABASE_URL is required for E2E");
  return new Pool({ connectionString: url });
}

// The customer-update audit row is written via fire-and-forget
// `void auditLog(...)` in src/lib/auth/guards.ts:206, so it may not be
// committed by the time the dialog closes. Poll until a matching row appears.
async function waitForAuditRow<R extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[],
  predicate: (row: R) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<R> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: R | undefined;
  while (Date.now() < deadline) {
    const result = await pool.query<R>(sql, params);
    const match = result.rows.find(predicate);
    if (match) return match;
    lastRow = result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for audit row matching predicate. Last row seen: ${
      lastRow ? JSON.stringify(lastRow) : "<none>"
    }`,
  );
}

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

    // Audit row: name-only edit must carry changedFields=["name"] and must
    // NOT include external_key in previous/next (#196 audit-shape acceptance).
    // Polled because the route writes the row via `void auditLog(...)`.
    const auditPool = await openAuditPool();
    try {
      const row = await waitForAuditRow<{
        details: {
          changedFields: string[];
          previous: Record<string, unknown>;
          next: Record<string, unknown>;
          customerId: string;
          customerName: string;
        };
      }>(
        auditPool,
        `SELECT details FROM audit_logs
         WHERE customer_id = $1 AND action = 'customer.updated'
         ORDER BY id DESC`,
        [testData.customer.id],
        (r) => r.details.customerName === renamed,
      );
      const details = row.details;
      expect(details.changedFields).toEqual(["name"]);
      expect(details.previous).not.toHaveProperty("external_key");
      expect(details.next).not.toHaveProperty("external_key");
      expect(details.customerId).toBe(testData.customer.id);
    } finally {
      await auditPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Edit dialog — prefill, inline help, and confirmed external_key change path
// (deferred from #196 acceptance criteria; existing tests above cancel out of
// the warning instead of confirming.)
// ---------------------------------------------------------------------------

test.describe("Admin customers page — edit dialog (prefill + inline help)", () => {
  test("edit dialog prefills fields and renders external_key inline help", async ({
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

    // Prefill — name + external_key reflect the row's current values.
    await expect(adminPage.locator("#customer-edit-name")).toHaveValue(
      testData.customer.name,
    );
    await expect(adminPage.locator("#customer-edit-external-key")).toHaveValue(
      testData.customer.externalKey,
    );

    // Inline help on the edit dialog points at the same operations guide as
    // the create dialog and is wired up via aria-describedby.
    const help = adminPage.locator("#customer-edit-external-key-help");
    await expect(help).toBeVisible();
    const link = help.getByRole("link", { name: "Operations guide" });
    await expect(link).toHaveAttribute(
      "href",
      /cross-system-customer-identification/,
    );
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(
      adminPage.locator("#customer-edit-external-key"),
    ).toHaveAttribute("aria-describedby", "customer-edit-external-key-help");
  });
});

test.describe("Admin customers page — external_key change confirm path", () => {
  test("Yes, change external_key issues PATCH, row updates, audit captures previous/next", async ({
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

    const newKey = `${testData.customer.externalKey}-changed`;
    await adminPage.locator("#customer-edit-external-key").fill(newKey);
    await adminPage.getByRole("button", { name: "Save" }).click();

    // Confirm warning copy variant: "change external_key" (not "remove").
    const warning = adminPage
      .locator('[role="dialog"]')
      .filter({ hasText: "Confirm external_key change" });
    await expect(warning).toBeVisible();
    await warning
      .getByRole("button", { name: "Yes, change external_key" })
      .click();

    // Both dialogs close once the PATCH succeeds.
    await expect(
      adminPage.getByRole("heading", { name: "Confirm external_key change" }),
    ).toBeHidden();
    await expect(
      adminPage.getByRole("heading", { name: "Edit Customer" }),
    ).toBeHidden();

    // The row reflects the new external_key.
    const updatedRow = adminPage.locator("tbody tr", {
      hasText: testData.customer.name,
    });
    await expect(updatedRow).toContainText(newKey);

    // Audit details capture previous + next external_key values plus the
    // customer id / name (#196 audit-shape acceptance). Polled because the
    // route writes the row via `void auditLog(...)`.
    const auditPool = await openAuditPool();
    try {
      const row = await waitForAuditRow<{
        details: {
          changedFields: string[];
          previous: { external_key?: string };
          next: { external_key?: string };
          customerId: string;
          customerName: string;
        };
      }>(
        auditPool,
        `SELECT details FROM audit_logs
         WHERE customer_id = $1 AND action = 'customer.updated'
         ORDER BY id DESC`,
        [testData.customer.id],
        (r) => r.details.next.external_key === newKey,
      );
      const details = row.details;
      expect(details.changedFields).toEqual(["external_key"]);
      expect(details.previous.external_key).toBe(testData.customer.externalKey);
      expect(details.customerId).toBe(testData.customer.id);
      expect(details.customerName).toBe(testData.customer.name);
    } finally {
      await auditPool.end();
    }
  });
});

test.describe("Admin customers page — authorization", () => {
  // The customers admin surface has two distinct guards (#196):
  //   - Page route: served under the admin layout; the client bootstraps via
  //     `adminFetch` which 401s for a general-context session and forces a
  //     redirect to /api/admin-auth/sign-in.
  //   - PATCH endpoint: guarded by `withAuth({ ctx: "admin" })` directly.
  // Both need explicit coverage — a passing API guard does not prove the
  // page redirect path is wired correctly (or vice versa).
  test("non-admin session is denied at the /en/admin/customers page route", async ({
    userPage,
  }) => {
    // The general-context `userPage` carries `at` / `csrf` cookies but no
    // `at_admin` / `csrf_admin`, so the admin layout's adminFetch call to
    // /api/admin-auth/me 401s and the customer-page bootstrap redirects to
    // /api/admin-auth/sign-in (see customers-page.tsx fetchCustomers).
    await userPage.goto("/en/admin/customers", { waitUntil: "load" });
    // Wait for the client-side redirect to land the URL anywhere outside
    // the customers admin page. The destination is OIDC discovery dependent
    // (admin sign-in → IdP), so the assertion is "we left the admin page",
    // not a specific landing URL.
    await userPage.waitForURL(
      (url) => !url.pathname.endsWith("/admin/customers"),
      { timeout: 10_000 },
    );
    expect(userPage.url()).not.toContain("/admin/customers");
  });

  test("PATCH /api/admin/customers/:id is denied for a non-admin session", async ({
    userPage,
    testData,
  }) => {
    const res = await userPage.request.patch(
      `/api/admin/customers/${testData.customer.id}`,
      {
        headers: { origin: "http://localhost:3000" },
        data: { name: `${testData.customer.name} should-not-apply` },
      },
    );
    expect(res.status()).toBe(401);

    // Defense-in-depth: confirm the DB row was not mutated.
    const auditPool = await openAuditPool();
    try {
      const audit = await auditPool.query(
        `SELECT id FROM audit_logs
         WHERE customer_id = $1
           AND action = 'customer.updated'
           AND details::text LIKE '%should-not-apply%'`,
        [testData.customer.id],
      );
      expect(audit.rowCount).toBe(0);
    } finally {
      await auditPool.end();
    }
  });
});
