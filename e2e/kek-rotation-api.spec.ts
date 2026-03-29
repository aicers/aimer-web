import { randomUUID } from "node:crypto";
import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E tests for POST /api/admin/kek/rotate (KEK rotation).
//
// Requires a running OpenBao instance with Transit engine enabled and
// a pre-created `staging-events` key.  CI provisions this via a dev-mode
// OpenBao service container; locally, `docker compose --profile dev up`
// provides the same.
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Transit API helpers — direct calls to OpenBao for test setup / teardown
// ---------------------------------------------------------------------------

function baoAddr(): string {
  return process.env.BAO_ADDR ?? "http://localhost:8200";
}

function baoToken(): string {
  return process.env.BAO_TOKEN ?? "";
}

async function createTransitKey(keyName: string): Promise<void> {
  const res = await fetch(`${baoAddr()}/v1/transit/keys/${keyName}`, {
    method: "POST",
    headers: { "X-Vault-Token": baoToken() },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to create Transit key ${keyName}: ${res.status}`);
  }
}

async function generateWrappedDek(keyName: string): Promise<string> {
  const res = await fetch(
    `${baoAddr()}/v1/transit/datakey/plaintext/${keyName}`,
    {
      method: "POST",
      headers: {
        "X-Vault-Token": baoToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to generate data key for ${keyName}: ${res.status}`,
    );
  }
  const json = (await res.json()) as { data: { ciphertext: string } };
  return json.data.ciphertext;
}

async function decryptWrappedDek(
  keyName: string,
  wrappedDek: string,
): Promise<string> {
  const res = await fetch(`${baoAddr()}/v1/transit/decrypt/${keyName}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": baoToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ciphertext: wrappedDek }),
  });
  if (!res.ok) {
    throw new Error(`Failed to decrypt DEK for ${keyName}: ${res.status}`);
  }
  const json = (await res.json()) as { data: { plaintext: string } };
  return json.data.plaintext;
}

async function deleteTransitKey(keyName: string): Promise<void> {
  // Enable deletion
  await fetch(`${baoAddr()}/v1/transit/keys/${keyName}/config`, {
    method: "POST",
    headers: {
      "X-Vault-Token": baoToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deletion_allowed: true }),
  });
  // Delete
  await fetch(`${baoAddr()}/v1/transit/keys/${keyName}`, {
    method: "DELETE",
    headers: { "X-Vault-Token": baoToken() },
  });
}

// =========================================================================
// Auth boundary tests (no OpenBao needed)
// =========================================================================

test.describe("POST /api/admin/kek/rotate — auth boundary", () => {
  test("returns 401 without admin auth cookie", async ({ request }) => {
    const res = await request.post("/api/admin/kek/rotate", {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 401 with general auth cookie", async ({ context }) => {
    await context.addCookies([
      {
        name: "at",
        value: "some-general-jwt",
        domain: "localhost",
        path: "/",
      },
    ]);
    const res = await context.request.post("/api/admin/kek/rotate", {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 405 for GET method", async ({ request }) => {
    const res = await request.get("/api/admin/kek/rotate");
    expect(res.status()).toBe(405);
  });
});

// =========================================================================
// Authenticated rotation with real Transit
// =========================================================================

test.describe("POST /api/admin/kek/rotate — authenticated", () => {
  test("rotates Transit keys and rewraps wrapped DEKs", async ({
    adminPage,
    testData,
  }) => {
    const pool = getTestPool();
    const testCustomerId = randomUUID();
    const testKeyName = `customer-${testCustomerId}`;

    // --- Setup: hide fixture customers from rotation query ---
    // Fixture customers have database_status='active' but no Transit keys.
    // Temporarily mark them as 'provisioning' so rotation skips them.
    const fixtureIds = [testData.customer.id, testData.customerB.id];
    await pool.query(
      `UPDATE customers SET database_status = 'provisioning' WHERE id = ANY($1)`,
      [fixtureIds],
    );

    try {
      // --- Setup: Transit key + customer with real wrapped DEK ---
      await createTransitKey(testKeyName);
      const customerWrappedDek = await generateWrappedDek(testKeyName);

      await pool.query(
        `INSERT INTO customers (id, external_key, name, status, database_status, wrapped_dek)
         VALUES ($1, $2, $3, 'active', 'active', $4)`,
        [
          testCustomerId,
          `e2e-rotate-${testCustomerId.slice(0, 8)}`,
          "KEK Rotation Test",
          customerWrappedDek,
        ],
      );

      // --- Setup: staged_event_payloads with real wrapped DEK ---
      const stagingWrappedDek = await generateWrappedDek("staging-events");
      const { rows: payloadRows } = await pool.query<{ id: string }>(
        `INSERT INTO staged_event_payloads
           (session_id, aice_id, payload_hash, payload, wrapped_dek,
            event_count, schema_version, expires_at)
         VALUES ($1, $2, md5(random()::text), $3, $4, 1, '1.0',
                 NOW() + INTERVAL '1 hour')
         RETURNING id`,
        [
          testData.admin.sessionId,
          testData.aiceEnvironment.aiceId,
          Buffer.from("e2e-rotation-payload"),
          stagingWrappedDek,
        ],
      );
      const payloadId = payloadRows[0].id;

      // --- Act: call rotation endpoint ---
      const cookies = await adminPage.context().cookies();
      const csrfValue = cookies.find((c) => c.name === "csrf_admin")?.value;

      const res = await adminPage.request.post("/api/admin/kek/rotate", {
        headers: {
          origin: ORIGIN,
          "x-csrf-token-admin": csrfValue as string,
        },
      });

      expect(res.status()).toBe(200);
      const result = await res.json();

      // --- Assert: response structure ---
      expect(result).toMatchObject({
        customerDeksRewrapped: expect.any(Number),
        eventDeksRewrapped: expect.any(Number),
        stagingDeksRewrapped: expect.any(Number),
        errors: expect.any(Array),
      });

      // Test customer has wrapped_dek → rewrapped.
      // connectCustomerDb fails (no real customer DB) → customersErrored.
      expect(result.customerDeksRewrapped).toBeGreaterThanOrEqual(1);
      expect(result.stagingDeksRewrapped).toBeGreaterThanOrEqual(1);

      // --- Assert: customer wrapped_dek changed in DB ---
      const { rows: custRows } = await pool.query<{ wrapped_dek: string }>(
        "SELECT wrapped_dek FROM customers WHERE id = $1",
        [testCustomerId],
      );
      const newCustomerDek = custRows[0].wrapped_dek;
      expect(newCustomerDek).not.toBe(customerWrappedDek);

      // New wrapped DEK decrypts to the same plaintext (rewrap preserves key material)
      const originalPlaintext = await decryptWrappedDek(
        testKeyName,
        customerWrappedDek,
      );
      const newPlaintext = await decryptWrappedDek(testKeyName, newCustomerDek);
      expect(newPlaintext).toBe(originalPlaintext);

      // --- Assert: staged payload wrapped_dek changed in DB ---
      const { rows: stagedRows } = await pool.query<{ wrapped_dek: string }>(
        "SELECT wrapped_dek FROM staged_event_payloads WHERE id = $1",
        [payloadId],
      );
      const newStagingDek = stagedRows[0].wrapped_dek;
      expect(newStagingDek).not.toBe(stagingWrappedDek);

      // New staging wrapped DEK also decrypts to same plaintext
      const origStagingPlaintext = await decryptWrappedDek(
        "staging-events",
        stagingWrappedDek,
      );
      const newStagingPlaintext = await decryptWrappedDek(
        "staging-events",
        newStagingDek,
      );
      expect(newStagingPlaintext).toBe(origStagingPlaintext);

      // --- Cleanup ---
      await pool.query("DELETE FROM staged_event_payloads WHERE id = $1", [
        payloadId,
      ]);
      await pool.query("DELETE FROM customers WHERE id = $1", [testCustomerId]);
      await deleteTransitKey(testKeyName);
    } finally {
      // Restore fixture customers
      await pool.query(
        `UPDATE customers SET database_status = 'active' WHERE id = ANY($1)`,
        [fixtureIds],
      );
    }
  });
});
