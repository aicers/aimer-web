import { expect, test } from "./fixtures";

// E2E tests for GET /api/admin/audit-logs with authenticated sessions.
// Exercises the full stack: auth, authorization, DB query, and response
// mapping with real test data.

const ENDPOINT = "/api/admin/audit-logs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a test audit log directly into audit_db and return its id. */
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
      actor_id: "e2e-actor-00000000-0000-0000-0000-000000000001",
      auth_context: "admin",
      action: "e2e.test_action",
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

/** Delete test audit logs by a specific actor_id prefix. */
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
      "DELETE FROM audit_logs WHERE actor_id LIKE 'e2e-actor-%'",
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Admin authorized access
// ---------------------------------------------------------------------------

test.describe("Audit logs — Admin authorized", () => {
  test.beforeAll(async () => {
    await cleanupAuditLogs();

    // Insert test entries with distinct actions for filter testing
    await insertAuditLog({
      action: "e2e.test_action_a",
      auth_context: "general",
    });
    await insertAuditLog({
      action: "e2e.test_action_b",
      auth_context: "admin",
    });
    await insertAuditLog({
      action: "e2e.test_action_a",
      auth_context: "admin",
      correlation_id: "e2e00000-0000-0000-0000-000000000001",
    });
  });

  test.afterAll(async () => {
    await cleanupAuditLogs();
  });

  test("Admin can query audit logs", async ({ adminPage }) => {
    const res = await adminPage.request.get(ENDPOINT);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    // Verify camelCase mapping
    const entry = body.data[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("actorId");
    expect(entry).toHaveProperty("authContext");
    expect(entry).toHaveProperty("action");
    expect(entry).toHaveProperty("targetType");
  });

  test("Admin can filter by auth_context", async ({ adminPage }) => {
    const res = await adminPage.request.get(`${ENDPOINT}?auth_context=general`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    for (const entry of body.data) {
      expect(entry.authContext).toBe("general");
    }
  });

  test("Admin can filter by action", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ENDPOINT}?action=e2e.test_action_a`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const entry of body.data) {
      expect(entry.action).toBe("e2e.test_action_a");
    }
  });

  test("Admin can filter by correlation_id", async ({ adminPage }) => {
    const corrId = "e2e00000-0000-0000-0000-000000000001";
    const res = await adminPage.request.get(
      `${ENDPOINT}?correlation_id=${corrId}`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) {
      expect(entry.correlationId).toBe(corrId);
    }
  });

  test("Admin can paginate with limit and cursor", async ({ adminPage }) => {
    const res1 = await adminPage.request.get(`${ENDPOINT}?limit=1`);
    expect(res1.status()).toBe(200);

    const body1 = await res1.json();
    expect(body1.data).toHaveLength(1);
    expect(body1.nextCursor).not.toBeNull();

    // Fetch next page
    const res2 = await adminPage.request.get(
      `${ENDPOINT}?limit=1&cursor=${body1.nextCursor}`,
    );
    expect(res2.status()).toBe(200);

    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    // Results should be different
    expect(body2.data[0].id).not.toBe(body1.data[0].id);
  });

  // =========================================================================
  // Validation errors (authenticated)
  // =========================================================================

  test("returns 400 for invalid auth_context value", async ({ adminPage }) => {
    const res = await adminPage.request.get(`${ENDPOINT}?auth_context=invalid`);
    expect(res.status()).toBe(400);
  });

  test("returns 400 for invalid customer_id UUID", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ENDPOINT}?customer_id=not-a-uuid`,
    );
    expect(res.status()).toBe(400);
  });

  test("returns 400 for invalid correlation_id UUID", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ENDPOINT}?correlation_id=bad-uuid`,
    );
    expect(res.status()).toBe(400);
  });

  test("returns 400 for limit out of range", async ({ adminPage }) => {
    const res = await adminPage.request.get(`${ENDPOINT}?limit=999`);
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Non-admin roles denied
// ---------------------------------------------------------------------------

test.describe("Audit logs — Non-admin denied", () => {
  test("Manager (general context) gets 403", async ({ managerPage }) => {
    const res = await managerPage.request.get(ENDPOINT);
    // The withAuth guard checks auth context — manager has general,
    // not admin, so the request is rejected
    expect([401, 403]).toContain(res.status());
  });

  test("User (general context) gets 403", async ({ userPage }) => {
    const res = await userPage.request.get(ENDPOINT);
    expect([401, 403]).toContain(res.status());
  });
});
