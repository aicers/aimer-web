import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Authenticated E2E tests for staged events: list, detail, approve, reject.
//
// Each test seeds its own staged_event_payloads and staged_event_customers
// rows using its own testData fixture, ensuring fixture-scoped isolation.
// Manual upload (POST /api/events/ingest) is excluded because it requires
// OpenBao Transit to be running for real encryption.
// ---------------------------------------------------------------------------

async function seedPayload(
  sessionId: string,
  customerId: string,
  opts?: { customerBId?: string; status?: string },
): Promise<string> {
  const pool = getTestPool();
  const p = await pool.query<{ id: string }>(
    `INSERT INTO staged_event_payloads
       (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
     VALUES ($1, 'aice-e2e', md5(random()::text), $2, 'vault:v1:e2edek', 10, '1.0', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [sessionId, Buffer.from("e2e-encrypted-payload")],
  );
  const payloadId = p.rows[0].id;

  const status = opts?.status ?? "pending";
  if (opts?.customerBId) {
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [payloadId, customerId, status, opts.customerBId],
    );
  } else {
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, $3)`,
      [payloadId, customerId, status],
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

test.describe("Staged events — authenticated flow", () => {
  test("GET /api/events/staged returns staged events for the session", async ({
    managerPage,
    testData,
  }) => {
    const id1 = await seedPayload(
      testData.manager.sessionId,
      testData.customer.id,
      {
        customerBId: testData.customerB.id,
      },
    );
    const id2 = await seedPayload(
      testData.manager.sessionId,
      testData.customer.id,
    );

    try {
      const res = await managerPage.request.get("/api/events/staged");
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.events).toBeDefined();
      expect(body.events.length).toBeGreaterThanOrEqual(2);

      const multi = body.events.find(
        (e: { payloadId: string }) => e.payloadId === id1,
      );
      expect(multi).toBeDefined();
      expect(multi.eventCount).toBe(10);
      expect(multi.customers).toHaveLength(2);
    } finally {
      await deletePayload(id1);
      await deletePayload(id2);
    }
  });

  test("GET /api/events/staged/:payloadId returns payload details", async ({
    managerPage,
    testData,
  }) => {
    const id = await seedPayload(
      testData.manager.sessionId,
      testData.customer.id,
      {
        customerBId: testData.customerB.id,
      },
    );

    try {
      const res = await managerPage.request.get(`/api/events/staged/${id}`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.event.payloadId).toBe(id);
      expect(body.event.customers).toHaveLength(2);
    } finally {
      await deletePayload(id);
    }
  });

  test("GET /api/events/staged/:payloadId returns 404 for other session's payload", async ({
    userPage,
    testData,
  }) => {
    // Seed with manager's session, query with user's page
    const id = await seedPayload(
      testData.manager.sessionId,
      testData.customer.id,
    );

    try {
      const res = await userPage.request.get(`/api/events/staged/${id}`);
      expect(res.status()).toBe(404);
    } finally {
      await deletePayload(id);
    }
  });

  test("PATCH approve and reject update customer status", async ({
    managerPage,
    testData,
  }) => {
    const id = await seedPayload(
      testData.manager.sessionId,
      testData.customer.id,
      {
        customerBId: testData.customerB.id,
      },
    );

    try {
      const csrf = (await managerPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      // Approve customer A
      const approveRes = await managerPage.request.patch(
        `/api/events/staged/${id}/customers/${testData.customer.id}`,
        {
          headers: {
            origin: "http://localhost:3000",
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "approve" },
        },
      );
      expect(approveRes.status()).toBe(200);
      const approveBody = await approveRes.json();
      expect(approveBody.status).toBe("approved");

      // Reject customer B
      const rejectRes = await managerPage.request.patch(
        `/api/events/staged/${id}/customers/${testData.customerB.id}`,
        {
          headers: {
            origin: "http://localhost:3000",
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "reject" },
        },
      );
      expect(rejectRes.status()).toBe(200);
      const rejectBody = await rejectRes.json();
      expect(rejectBody.status).toBe("rejected");
    } finally {
      // Payload may have been auto-deleted (all customers terminal)
      await deletePayload(id).catch(() => {});
    }
  });

  test("PATCH approve on non-pending customer returns 409", async ({
    managerPage,
    testData,
  }) => {
    // Seed a pre-approved customer
    const pool = getTestPool();
    const p = await pool.query<{ id: string }>(
      `INSERT INTO staged_event_payloads
         (session_id, aice_id, payload_hash, payload, wrapped_dek, event_count, schema_version, expires_at)
       VALUES ($1, 'aice-e2e', md5(random()::text), $2, 'vault:v1:e2edek', 5, '2.0', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [testData.manager.sessionId, Buffer.from("e2e-encrypted-409")],
    );
    const id = p.rows[0].id;

    // Insert two customers: one approved, one pending (so payload is not auto-cleaned)
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status, approved_at)
       VALUES ($1, $2, 'approved', NOW())`,
      [id, testData.customer.id],
    );
    await pool.query(
      `INSERT INTO staged_event_customers (payload_id, customer_id, status)
       VALUES ($1, $2, 'pending')`,
      [id, testData.customerB.id],
    );

    try {
      const csrf = (await managerPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const res = await managerPage.request.patch(
        `/api/events/staged/${id}/customers/${testData.customer.id}`,
        {
          headers: {
            origin: "http://localhost:3000",
            "x-csrf-token": csrf ?? "",
          },
          data: { action: "approve" },
        },
      );
      expect(res.status()).toBe(409);
    } finally {
      await deletePayload(id);
    }
  });
});
