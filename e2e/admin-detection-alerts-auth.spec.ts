import { expect, test } from "./fixtures";

// E2E tests for GET /api/admin/detection/alerts with authenticated
// sessions. Exercises the full stack: auth, authorization, DB query,
// and response mapping with real test data.

const ALERTS_ENDPOINT = "/api/admin/detection/alerts";
const SUMMARY_ENDPOINT = "/api/admin/detection/alerts/summary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a test alert directly into audit_db and return its id. */
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
      indicator: "e2e_test_indicator",
      severity: "warning",
      actor_id: "e2e-actor-00000000-0000-0000-0000-000000000099",
      ip_address: "127.0.0.1",
      summary: JSON.stringify({ test: true }),
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

/** Delete test alerts by actor_id prefix. */
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
      "DELETE FROM suspicious_activity_alerts WHERE actor_id LIKE 'e2e-actor-%'",
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Admin authorized access — alerts list
// ---------------------------------------------------------------------------

test.describe("Detection alerts — Admin authorized", () => {
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
    await insertTestAlert({
      indicator: "bridge_abuse",
      severity: "warning",
    });
  });

  test.afterAll(async () => {
    await cleanupTestAlerts();
  });

  test("Admin can query detection alerts", async ({ adminPage }) => {
    const res = await adminPage.request.get(ALERTS_ENDPOINT);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    // Verify camelCase mapping
    const entry = body.data[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("createdAt");
    expect(entry).toHaveProperty("indicator");
    expect(entry).toHaveProperty("severity");
    expect(entry).toHaveProperty("actorId");
    expect(entry).toHaveProperty("ipAddress");
    expect(entry).toHaveProperty("summary");
    expect(entry).toHaveProperty("auditLogIds");
  });

  test("Admin can filter by severity", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?severity=severe`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    for (const entry of body.data) {
      expect(entry.severity).toBe("severe");
    }
  });

  test("Admin can filter by indicator", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?indicator=bridge_abuse`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    for (const entry of body.data) {
      expect(entry.indicator).toBe("bridge_abuse");
    }
  });

  test("Admin can paginate with limit and cursor", async ({ adminPage }) => {
    const res1 = await adminPage.request.get(`${ALERTS_ENDPOINT}?limit=1`);
    expect(res1.status()).toBe(200);

    const body1 = await res1.json();
    expect(body1.data).toHaveLength(1);
    expect(body1.nextCursor).not.toBeNull();

    const res2 = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?limit=1&cursor=${body1.nextCursor}`,
    );
    expect(res2.status()).toBe(200);

    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].id).not.toBe(body1.data[0].id);
  });

  // =========================================================================
  // Validation errors (authenticated)
  // =========================================================================

  test("returns 400 for invalid severity value", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?severity=invalid`,
    );
    expect(res.status()).toBe(400);
  });

  test("returns 400 for limit out of range", async ({ adminPage }) => {
    const res = await adminPage.request.get(`${ALERTS_ENDPOINT}?limit=999`);
    expect(res.status()).toBe(400);
  });

  test("returns 400 for invalid indicator value", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?indicator=nonexistent`,
    );
    expect(res.status()).toBe(400);
  });

  test("returns 400 for invalid from date", async ({ adminPage }) => {
    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?from=not-a-date`,
    );
    expect(res.status()).toBe(400);
  });

  test("returns 400 for invalid to date", async ({ adminPage }) => {
    const res = await adminPage.request.get(`${ALERTS_ENDPOINT}?to=not-a-date`);
    expect(res.status()).toBe(400);
  });

  test("can filter by date range", async ({ adminPage }) => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?from=${yesterday.toISOString()}&to=${tomorrow.toISOString()}`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    // All seeded alerts should be within the range
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty with out-of-range dates", async ({ adminPage }) => {
    const farPast = new Date("2000-01-01T00:00:00Z");
    const alsoFarPast = new Date("2000-01-02T00:00:00Z");

    const res = await adminPage.request.get(
      `${ALERTS_ENDPOINT}?from=${farPast.toISOString()}&to=${alsoFarPast.toISOString()}`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Admin authorized access — summary
// ---------------------------------------------------------------------------

test.describe("Detection summary — Admin authorized", () => {
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

  test("Admin can get summary counts", async ({ adminPage }) => {
    const res = await adminPage.request.get(SUMMARY_ENDPOINT);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(typeof body.severe).toBe("number");
    expect(typeof body.warning).toBe("number");
    expect(body.byIndicator).toBeDefined();
    expect(typeof body.byIndicator).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Non-admin roles denied
// ---------------------------------------------------------------------------

test.describe("Detection alerts — Non-admin denied", () => {
  test("Manager (general context) gets 401/403", async ({ managerPage }) => {
    const res = await managerPage.request.get(ALERTS_ENDPOINT);
    expect([401, 403]).toContain(res.status());
  });

  test("User (general context) gets 401/403", async ({ userPage }) => {
    const res = await userPage.request.get(ALERTS_ENDPOINT);
    expect([401, 403]).toContain(res.status());
  });

  test("Manager cannot access summary", async ({ managerPage }) => {
    const res = await managerPage.request.get(SUMMARY_ENDPOINT);
    expect([401, 403]).toContain(res.status());
  });
});
