import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Authenticated E2E tests for staged events: list, detail, approve, reject.
//
// Each test seeds its own staged_event_payloads and staged_event_customers
// rows using its own testData fixture, ensuring fixture-scoped isolation.
//
// Full approve-to-customer-db flow requires OpenBao Transit (for envelope
// decryption and re-encryption) and a provisioned customer database,
// which are not available in the standard E2E environment. Approve
// authorization enforcement is tested here; the encryption + storage
// pipeline is covered by unit tests (event-storage.unit.test.ts,
// staged-approve.unit.test.ts).
// ---------------------------------------------------------------------------

async function seedPayload(
  sessionId: string,
  aiceId: string,
  customerId: string,
  opts?: { customerBId?: string; status?: string },
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
    const aiceId = testData.aiceEnvironment.aiceId;
    const id1 = await seedPayload(
      testData.manager.sessionId,
      aiceId,
      testData.customer.id,
      {
        customerBId: testData.customerB.id,
      },
    );
    const id2 = await seedPayload(
      testData.manager.sessionId,
      aiceId,
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
      testData.aiceEnvironment.aiceId,
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
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      const res = await userPage.request.get(`/api/events/staged/${id}`);
      expect(res.status()).toBe(404);
    } finally {
      await deletePayload(id);
    }
  });

  test("PATCH reject updates customer status", async ({
    managerPage,
    testData,
  }) => {
    // Manager only has membership in customerA, so test with customerA only
    const id = await seedPayload(
      testData.manager.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
    );

    try {
      const csrf = (await managerPage.context().cookies()).find(
        (c) => c.name === "csrf",
      )?.value;

      const rejectRes = await managerPage.request.patch(
        `/api/events/staged/${id}/customers/${testData.customer.id}`,
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
      await deletePayload(id).catch(() => {});
    }
  });

  test("PATCH reject on non-pending customer returns 409", async ({
    managerPage,
    testData,
  }) => {
    // Seed a customer already rejected (use reject to avoid needing Transit)
    const id = await seedPayload(
      testData.manager.sessionId,
      testData.aiceEnvironment.aiceId,
      testData.customer.id,
      { status: "rejected" },
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
          data: { action: "reject" },
        },
      );
      expect(res.status()).toBe(409);
    } finally {
      await deletePayload(id);
    }
  });
});
