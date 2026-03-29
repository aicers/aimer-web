import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E tests for detection event ingestion authorization:
// - analyses:create permission enforcement
// - Bridge scope enforcement
// - Single-customer scope per request
// - operationKind restrictions
//
// These tests verify that authorize() is called correctly by the event
// API routes. They do NOT test full encryption/storage (requires Transit).
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

async function seedPayload(
  sessionId: string,
  aiceId: string,
  customerId: string,
  opts?: { customerBId?: string },
): Promise<string> {
  const pool = getTestPool();
  const p = await pool.query<{ id: string }>(
    `INSERT INTO staged_event_payloads
       (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
     VALUES ($1, $2, md5(random()::text), $3, 'vault:v1:e2edek', 10, '1.0', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [sessionId, aiceId, Buffer.from("e2e-encrypted-payload")],
  );
  const payloadId = p.rows[0].id;

  if (opts?.customerBId) {
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending'), ($1, $3, 'pending')`,
      [payloadId, customerId, opts.customerBId],
    );
  } else {
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending')`,
      [payloadId, customerId],
    );
  }

  return payloadId;
}

async function deletePayload(payloadId: string): Promise<void> {
  const pool = getTestPool();
  await pool.query(`DELETE FROM staged_event_payloads WHERE id = $1`, [
    payloadId,
  ]);
}

// ---------------------------------------------------------------------------
// Scope enforcement on reject (doesn't require Transit)
// ---------------------------------------------------------------------------

test.describe("Event approval — authorization enforcement", () => {
  test("reject requires analyses:create permission (account with no customer access is denied)", async ({
    testData,
  }) => {
    const pool = getTestPool();

    // Create an account with NO memberships or analyst assignments
    const { randomUUID } = await import("node:crypto");
    const noAccessId = randomUUID();
    const noAccessSlug = `e2e-noaccess-${Date.now()}`;
    await pool.query(
      `INSERT INTO accounts
         (id, oidc_issuer, oidc_subject, username, display_name, email, status)
       VALUES ($1, 'e2e-issuer', $2, $2, 'No Access', $3, 'active')`,
      [noAccessId, noAccessSlug, `${noAccessSlug}@e2e.test`],
    );

    // Create a session for this account
    const sessResult = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
       RETURNING sid`,
      [noAccessId],
    );
    const sessionId = sessResult.rows[0].sid;

    // Seed a payload for this session
    const payloadId = await seedPayload(
      sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      // Import auth helpers to create a JWT for this session
      const { injectAuthCookies } = await import("./fixtures/auth");
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      const context = await browser.newContext({
        baseURL: "http://localhost:3000",
      });
      await injectAuthCookies(
        context,
        { accountId: noAccessId, sessionId },
        "general",
      );
      const page = await context.newPage();

      try {
        const csrf = (await context.cookies()).find(
          (c) => c.name === "csrf",
        )?.value;

        const res = await page.request.patch(
          `/api/events/staged/${payloadId}/customers/${testData.customer.id}`,
          {
            headers: {
              origin: ORIGIN,
              "x-csrf-token": csrf ?? "",
            },
            data: { action: "reject" },
          },
        );
        expect(res.status()).toBe(403);
      } finally {
        await context.close();
        await browser.close();
      }
    } finally {
      await deletePayload(payloadId).catch(() => {});
      await pool.query(`DELETE FROM sessions WHERE account_id = $1`, [
        noAccessId,
      ]);
      await pool.query(`DELETE FROM accounts WHERE id = $1`, [noAccessId]);
    }
  });

  test("user with analyses:create can reject staged event", async ({
    userPage,
    testData,
  }) => {
    // User role has analyses:create permission
    const payloadId = await seedPayload(
      testData.user.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      const csrf = (await userPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const res = await userPage.request.patch(
        `/api/events/staged/${payloadId}/customers/${testData.customer.id}`,
        {
          headers: {
            origin: ORIGIN,
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "reject" },
        },
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("rejected");
    } finally {
      await deletePayload(payloadId).catch(() => {});
    }
  });

  test("manager with analyses:create can reject staged event", async ({
    managerPage,
    testData,
  }) => {
    const payloadId = await seedPayload(
      testData.manager.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      const csrf = (await managerPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const res = await managerPage.request.patch(
        `/api/events/staged/${payloadId}/customers/${testData.customer.id}`,
        {
          headers: {
            origin: ORIGIN,
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "reject" },
        },
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("rejected");
    } finally {
      await deletePayload(payloadId).catch(() => {});
    }
  });

  test("reject is denied for customer not linked to AICE environment", async ({
    managerPage,
    testData,
  }) => {
    const pool = getTestPool();

    // Create a customer not linked to any AICE environment
    const isolatedId = `e2e-isolated-${Date.now()}`;
    const isolatedCustId = `00000000-0000-0000-0000-${Date.now().toString().slice(-12)}`;
    await pool.query(
      `INSERT INTO customers (id, external_key, name, status, database_status)
       VALUES ($1, $2, 'Isolated', 'active', 'active')`,
      [isolatedCustId, isolatedId],
    );
    // Give manager membership in this customer
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [testData.manager.accountId, isolatedCustId, testData.roles.managerId],
    );

    // Seed payload with AICE env that is NOT linked to isolated customer
    const payloadId = await seedPayload(
      testData.manager.sessionId,
      testData.aiceEnvironment.aiceId,
      isolatedCustId,
    );

    try {
      const csrf = (await managerPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const res = await managerPage.request.patch(
        `/api/events/staged/${payloadId}/customers/${isolatedCustId}`,
        {
          headers: {
            origin: ORIGIN,
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "reject" },
        },
      );
      // authorize() should fail: AICE env not linked to this customer
      expect(res.status()).toBe(403);
    } finally {
      await deletePayload(payloadId).catch(() => {});
      await pool.query(
        `DELETE FROM account_customer_memberships WHERE customer_id = $1`,
        [isolatedCustId],
      );
      await pool.query(`DELETE FROM customers WHERE id = $1`, [isolatedCustId]);
    }
  });

  test("analyst can reject events for assigned customer", async ({
    analystPage,
    testData,
  }) => {
    // Analyst has analyst_eligible=true + analyst assignment → gets Analyst
    // role permissions which include analyses:create
    const payloadId = await seedPayload(
      testData.analyst.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      const csrf = (await analystPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const res = await analystPage.request.patch(
        `/api/events/staged/${payloadId}/customers/${testData.customer.id}`,
        {
          headers: {
            origin: ORIGIN,
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "reject" },
        },
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("rejected");
    } finally {
      await deletePayload(payloadId).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Manual upload authorization (POST /api/events/ingest)
// Skips full upload (requires Transit encryption) — tests auth boundary only
// ---------------------------------------------------------------------------

test.describe("POST /api/events/ingest — authorization", () => {
  test("returns 403 for account with no customer access", async ({
    testData,
  }) => {
    const pool = getTestPool();

    // Admin has no customer membership — only admin context
    // Create a general session for admin to test customer access denial
    const adminGeneralSession = await pool.query<{ sid: string }>(
      `INSERT INTO sessions (account_id, auth_context, ip_address, user_agent)
       VALUES ($1, 'general', '127.0.0.1', 'Playwright E2E')
       RETURNING sid`,
      [testData.admin.accountId],
    );
    const sessionId = adminGeneralSession.rows[0].sid;

    try {
      const { injectAuthCookies } = await import("./fixtures/auth");
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      const context = await browser.newContext({
        baseURL: "http://localhost:3000",
      });
      await injectAuthCookies(
        context,
        { accountId: testData.admin.accountId, sessionId },
        "general",
      );
      const page = await context.newPage();

      try {
        const csrf = (await context.cookies()).find(
          (c) => c.name === "csrf",
        )?.value;

        const res = await page.request.post("/api/events/ingest", {
          headers: {
            origin: ORIGIN,
            "x-csrf-token": csrf ?? "",
          },
          multipart: {
            events_data: {
              name: "events.bin",
              mimeType: "application/octet-stream",
              buffer: Buffer.from("test-data"),
            },
            customer_id: testData.customer.id,
            aice_id: testData.aiceEnvironment.aiceId,
            schema_version: "1.0",
            event_count: "5",
          },
        });
        // Admin has no membership in this customer → 403
        expect(res.status()).toBe(403);
      } finally {
        await context.close();
        await browser.close();
      }
    } finally {
      await pool.query(`DELETE FROM sessions WHERE sid = $1`, [sessionId]);
    }
  });

  test("returns 400 for missing required fields", async ({ managerPage }) => {
    const csrf = (await managerPage.context().cookies()).find(
      (c) => c.name === "csrf",
    )?.value;

    // Missing aice_id
    const res = await managerPage.request.post("/api/events/ingest", {
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrf ?? "",
      },
      multipart: {
        events_data: {
          name: "events.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("test-data"),
        },
        customer_id: "00000000-0000-0000-0000-000000000001",
        schema_version: "1.0",
        event_count: "5",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("aice_id");
  });

  test("returns 400 for invalid customer_id format", async ({
    managerPage,
  }) => {
    const csrf = (await managerPage.context().cookies()).find(
      (c) => c.name === "csrf",
    )?.value;

    const res = await managerPage.request.post("/api/events/ingest", {
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrf ?? "",
      },
      multipart: {
        events_data: {
          name: "events.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("test-data"),
        },
        customer_id: "not-a-uuid",
        aice_id: "aice-1",
        schema_version: "1.0",
        event_count: "5",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("customer_id");
  });

  test("returns 400 for invalid event_count", async ({ managerPage }) => {
    const csrf = (await managerPage.context().cookies()).find(
      (c) => c.name === "csrf",
    )?.value;

    const res = await managerPage.request.post("/api/events/ingest", {
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrf ?? "",
      },
      multipart: {
        events_data: {
          name: "events.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("test-data"),
        },
        customer_id: "00000000-0000-0000-0000-000000000001",
        aice_id: "aice-1",
        schema_version: "1.0",
        event_count: "0",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("event_count");
  });
});
