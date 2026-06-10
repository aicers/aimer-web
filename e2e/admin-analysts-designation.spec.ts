import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E for the analyst designation flow (Discussion #9 items 42-2 / 42-3 / 42-4).
//
// Authorization model recap (src/lib/auth/authorization.ts): an account gets
// analyst-scoped access to a customer only when analyst_eligible = true AND an
// active analyst_customer_assignments row exists. Effective general-context
// permissions are the UNION of membership-role grants and analyst grants.
//
// Verification surface: GET /api/auth/customers returns the accessible-customer
// set, each row carrying { role, isAnalyst, permissions }. This is the
// detailed view authorizeGeneral computes, so it makes both the analyst flag
// and the permission union directly observable for a page's live session.
//
// Per the issue: only the admin management surface needs real browser
// interaction (42-2 designates + assigns by operating /admin/analysts);
// permission *effects* are confirmed with request assertions against the
// authenticated page's own session, which is explicitly not the "API
// re-verification" 42-4 must avoid.
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

// Permission keys that only the Analyst role grants (seeded by
// migrations/auth/0000_init.sql). The User and Manager roles never grant
// these, so their presence proves a grant arrived via an analyst
// assignment rather than a membership role.
const ANALYST_ONLY_PERMISSIONS = [
  "analyses:export",
  "analyses:configure",
  "reports:create",
  "reports:schedule",
  "dashboard:customize",
];

interface AccessibleCustomer {
  id: string;
  name: string;
  externalKey: string;
  role: string | null;
  isAnalyst: boolean;
  permissions: string[];
}

async function fetchAccessibleCustomers(
  page: Page,
): Promise<AccessibleCustomer[]> {
  const res = await page.request.get("/api/auth/customers");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { customers: AccessibleCustomer[] };
  return body.customers;
}

function findCustomer(
  customers: AccessibleCustomer[],
  id: string,
): AccessibleCustomer | undefined {
  return customers.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// 42-2 — Direct designation, immediate effect.
//
// Designate the seeded `user` (not analyst-eligible; User membership in
// Customer A) through the admin UI and assign Customer B, where `user` has no
// membership — so the new analyst grant is observable rather than hidden by
// the membership/analyst union. Then confirm the target's PRE-EXISTING general
// session (userPage, no re-login) sees the grant on its very next request.
// ---------------------------------------------------------------------------

test.describe("Analyst designation — 42-2 direct designation, immediate effect", () => {
  test("designating + assigning via admin UI grants access to the target's live session immediately", async ({
    adminPage,
    userPage,
    testData,
  }) => {
    // Baseline: the target's existing session sees only its Customer A
    // membership; Customer B is not yet accessible.
    const before = await fetchAccessibleCustomers(userPage);
    const beforeA = findCustomer(before, testData.customer.id);
    expect(beforeA).toBeDefined();
    expect(beforeA?.role).toBe("User");
    expect(beforeA?.isAnalyst).toBe(false);
    expect(findCustomer(before, testData.customerB.id)).toBeUndefined();

    // Drive the designation through the browser, not the admin API.
    await adminPage.goto("/en/admin/analysts");
    await expect(
      adminPage.getByRole("heading", { name: "Analysts", level: 1 }),
    ).toBeVisible();

    const designateButton = adminPage.getByRole("button", {
      name: "Designate Analyst",
    });
    // The toolbar button is disabled until the customer/account pickers load.
    await expect(designateButton).toBeEnabled();
    await designateButton.click();

    const dialog = adminPage
      .locator('[role="dialog"]')
      .filter({ hasText: "Designate Analyst" });
    await expect(dialog).toBeVisible();

    // Pick the target account by its (unique) email, then assign Customer B.
    await dialog.locator("#designate-search").fill(testData.user.email);
    await dialog
      .getByRole("button")
      .filter({ hasText: testData.user.email })
      .click();
    await expect(
      dialog.getByText(`Selected: ${testData.user.displayName}`),
    ).toBeVisible();

    await dialog
      .locator("label")
      .filter({ hasText: testData.customerB.name })
      .getByRole("checkbox")
      .check();

    await dialog.getByRole("button", { name: "Designate Analyst" }).click();

    // The operation succeeded (toast) and the dialog closed.
    await expect(adminPage.getByText("Analyst designated.")).toBeVisible();
    await expect(dialog).toBeHidden();

    // Immediate effect: the SAME pre-existing user session now sees Customer B
    // as an analyst-granted customer on its next request — no re-login.
    const after = await fetchAccessibleCustomers(userPage);
    const afterB = findCustomer(after, testData.customerB.id);
    expect(afterB).toBeDefined();
    expect(afterB?.isAnalyst).toBe(true);
    // No membership in Customer B, so the grant is purely the analyst role.
    expect(afterB?.role).toBeNull();
    expect(afterB?.permissions).toContain("analyses:create");

    // Customer A membership is untouched by the designation.
    const afterA = findCustomer(after, testData.customer.id);
    expect(afterA?.role).toBe("User");
  });
});

// ---------------------------------------------------------------------------
// 42-3 — Analyst-only account (no membership).
//
// The seeded `analyst` is analyst_eligible with an assignment for Customer A
// and NO membership anywhere. Analyst features for the assigned customer are
// reachable; membership-gated customer management (member list) is blocked.
// ---------------------------------------------------------------------------

test.describe("Analyst designation — 42-3 analyst-only account", () => {
  test("analyst features reach the assigned customer while membership-gated management is denied", async ({
    analystPage,
    testData,
  }) => {
    const customers = await fetchAccessibleCustomers(analystPage);

    // Customer A is reachable purely via the analyst assignment.
    const custA = findCustomer(customers, testData.customer.id);
    expect(custA).toBeDefined();
    expect(custA?.isAnalyst).toBe(true);
    expect(custA?.role).toBeNull(); // analyst-only: no membership role
    // Analyst grants advanced analysis permissions.
    expect(custA?.permissions).toContain("analyses:create");
    for (const perm of ANALYST_ONLY_PERMISSIONS) {
      expect(custA?.permissions).toContain(perm);
    }

    // Scope: the analyst is only assigned Customer A, so Customer B (which it
    // is neither a member of nor assigned to) is not accessible.
    expect(findCustomer(customers, testData.customerB.id)).toBeUndefined();

    // Member management requires a membership role (customer-members:write),
    // which the Analyst role does not grant — denied for the assigned customer.
    const membersRes = await analystPage.request.get(
      `/api/members?customer_id=${testData.customer.id}`,
    );
    expect(membersRes.status()).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 42-4 — Analyst + Customer account.
//
// The seeded `multiRole` is User in Customer A, Manager in Customer B, plus
// analyst_eligible with an analyst assignment for Customer A. The pure
// membership matrix is already covered by authorization-api.spec.ts; this spec
// adds the analyst-assignment dimension: the union must lift Customer A's
// effective permissions above its plain User membership, and the analyst grant
// must stay scoped to Customer A (not leak into the Manager-only Customer B).
// ---------------------------------------------------------------------------

test.describe("Analyst designation — 42-4 analyst + customer account", () => {
  test("per-customer permissions resolve as the union of membership and analyst grants", async ({
    multiRolePage,
    testData,
  }) => {
    const customers = await fetchAccessibleCustomers(multiRolePage);

    // Customer A: User membership AND an analyst assignment.
    const custA = findCustomer(customers, testData.customer.id);
    expect(custA).toBeDefined();
    expect(custA?.role).toBe("User");
    expect(custA?.isAnalyst).toBe(true);
    // The analyst-assignment dimension: Customer A's permissions exceed the
    // plain User role because the analyst grant is unioned in. These keys are
    // Analyst-only — a User membership alone would never expose them.
    for (const perm of ANALYST_ONLY_PERMISSIONS) {
      expect(custA?.permissions).toContain(perm);
    }

    // Customer B: Manager membership, NO analyst assignment.
    const custB = findCustomer(customers, testData.customerB.id);
    expect(custB).toBeDefined();
    expect(custB?.role).toBe("Manager");
    expect(custB?.isAnalyst).toBe(false);
    // Manager grants member management...
    expect(custB?.permissions).toContain("customer-members:write");
    // ...but the analyst grant is scoped to Customer A and must NOT bleed into
    // Customer B: none of the analyst-only permissions appear here.
    for (const perm of ANALYST_ONLY_PERMISSIONS) {
      expect(custB?.permissions).not.toContain(perm);
    }

    // Browser-driven effect of the union, confirmed against the page session:
    // analyst-granted analyses:create lets the multi-role user act on a staged
    // event for Customer A. Per-test ephemeral data, torn down in `finally`.
    const payloadId = await seedStagedPayload(
      testData.multiRole.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );
    try {
      const csrf = (await multiRolePage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;
      const res = await multiRolePage.request.patch(
        `/api/events/staged/${payloadId}/customers/${testData.customer.id}`,
        {
          headers: { origin: ORIGIN, "x-csrf-token": csrf ?? "" },
          data: { action: "reject" },
        },
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("rejected");
    } finally {
      await deleteStagedPayload(payloadId).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Per-test ephemeral staged-event helpers (mirrors the seedPayload /
// deletePayload + finally-cleanup pattern in e2e/ingestion-auth.spec.ts).
// ---------------------------------------------------------------------------

async function seedStagedPayload(
  sessionId: string,
  aiceId: string,
  customerId: string,
): Promise<string> {
  const { getTestPool } = await import("./fixtures");
  const pool = getTestPool();
  const p = await pool.query<{ id: string }>(
    `INSERT INTO staged_event_payloads
       (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
     VALUES ($1, $2, md5(random()::text), $3, 'vault:v1:e2edek', 10, '1.0', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [sessionId, aiceId, Buffer.from("e2e-encrypted-payload")],
  );
  const payloadId = p.rows[0].id;
  await pool.query(
    `INSERT INTO staged_event_customers (payload_id, customer_id, status)
     VALUES ($1, $2, 'pending')`,
    [payloadId, customerId],
  );
  return payloadId;
}

async function deleteStagedPayload(payloadId: string): Promise<void> {
  const { getTestPool } = await import("./fixtures");
  const pool = getTestPool();
  await pool.query(`DELETE FROM staged_event_payloads WHERE id = $1`, [
    payloadId,
  ]);
}
