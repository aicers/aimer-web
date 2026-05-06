/**
 * Route-level integration test: exercises the real `/api/auth/bridge`
 * POST handler against a real Postgres test DB and the real
 * `verifyEventsEnvelope`, `createPendingConnection`, and
 * `stageEventsPayload` collaborators.
 *
 * Mocked seams (out of scope for this test):
 *  - `verifyContextToken` — context-token cryptography is covered by
 *    its own unit tests.
 *  - `@/lib/crypto/envelope.encryptPayload` — depends on a running
 *    OpenBao Transit service. We substitute deterministic ciphertext
 *    so the real DB insert still runs end to end.
 *  - `@/lib/auth/cookies` — `next/headers` cookies are not available
 *    in the vitest runtime; the route does not return cookie state we
 *    need to assert here.
 *  - `auditLog` — audit writes go to a separate DB pool we do not
 *    provision in this test.
 *
 * Scope: prove that a `FormData.append("events_data", jsonString)`
 * request reaches the route, traverses the new `TextEncoder` branch,
 * verifies a real signed JWS envelope using the seeded trust registry,
 * inserts a `pending_connections` row, and inserts a
 * `staged_event_payloads` row whose `payload_hash` matches
 * SHA-256 of the exact UTF-8 bytes from the form part.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { NextRequest } from "next/server";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../../../lib/db/__tests__/db-test-helpers";
import { runMigrations } from "../../../../lib/db/migrate";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 2095;

// ---------------------------------------------------------------------------
// Mocks for collaborators that are out of scope or require external services.
// ---------------------------------------------------------------------------

// Allow real lib/* modules (which use `import "server-only"`) to load
// in the vitest runtime.
vi.mock("server-only", () => ({}));

const mockVerifyContextToken = vi.fn();
vi.mock("@/lib/auth/context-token", () => ({
  verifyContextToken: (...args: unknown[]) => mockVerifyContextToken(...args),
}));

vi.mock("@/lib/auth/cookies", () => ({
  setConnectionIdCookie: vi.fn(async () => {}),
  clearInvitationTokenCookie: vi.fn(async () => {}),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(async () => {}),
  UNKNOWN_ACTOR_ID: "unknown",
}));

// Substitute encryption so the staged_event_payloads insert can run
// without requiring OpenBao Transit. We still pass the *real* plaintext
// bytes through, so payload_hash verification (which happens before
// encryption inside verifyEventsEnvelope) covers the path under test.
vi.mock("@/lib/crypto/envelope", () => ({
  encryptPayload: vi.fn(async (plaintext: Buffer) => ({
    ciphertext: Buffer.concat([Buffer.from("test-ct:"), plaintext]),
    wrappedDek: "test-wrapped-dek",
  })),
}));

// Hoisted holder for the test pool. The route calls `getAuthPool()` at
// request time; we point it at our test DB.
const poolHolder: { current: Pool | null } = { current: null };
vi.mock("@/lib/db/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
  return {
    ...actual,
    getAuthPool: () => {
      if (!poolHolder.current) throw new Error("test pool not initialized");
      return poolHolder.current;
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUER = "https://aice.test";
const AICE_ID = "aice-bridge-route-1";
const KID = "key-bridge-route-1";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

async function signEnvelope(params: {
  payloadHash: string;
  contextJti: string;
  customerIds: string[];
  eventCount: number;
  schemaVersion: string;
}): Promise<string> {
  const claims = {
    iss: ISSUER,
    aice_id: AICE_ID,
    customer_ids: params.customerIds,
    context_jti: params.contextJti,
    payload_hash: params.payloadHash,
    event_count: params.eventCount,
    schema_version: params.schemaVersion,
  };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .sign(privateKey);
}

function makeBridgeRequest(form: FormData): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/bridge", {
    method: "POST",
    body: form,
  });
}

async function callPOST(req: NextRequest): Promise<Response> {
  const { POST } = await import("../bridge/route");
  return POST(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasPostgres)(
  "POST /api/auth/bridge — route+db integration",
  () => {
    let pool: Pool;
    let dbName: string;

    beforeAll(async () => {
      const result = await createTestDatabase("bridge_route", "auth");
      pool = result.pool;
      dbName = result.dbName;
      poolHolder.current = pool;

      await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

      await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

      // Generate keypair and seed trust registry
      const kp = await generateKeyPair("ES256");
      privateKey = kp.privateKey;
      publicJwk = await exportJWK(kp.publicKey);

      await pool.query(
        `INSERT INTO customers (external_key, name, status, database_status)
       VALUES ('ext-route-a', 'Customer A', 'active', 'active')`,
      );
      await pool.query(
        `INSERT INTO aice_environments (aice_id, name, status)
       VALUES ($1, 'Bridge Route AICE', 'active')`,
        [AICE_ID],
      );
      await pool.query(
        `INSERT INTO trust_registry (aice_id, issuer, kid, public_key)
       VALUES ($1, $2, $3, $4)`,
        [AICE_ID, ISSUER, KID, JSON.stringify(publicJwk)],
      );
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool, "auth");
      await closeAdminPool();
    });

    beforeEach(() => {
      vi.clearAllMocks();
      // Reset mock to default for each test; tests can override.
      mockVerifyContextToken.mockReset();
    });

    it("string events_data: end-to-end — real verifyEventsEnvelope, real DB inserts", async () => {
      const jti = `route-jti-${Date.now()}`;
      mockVerifyContextToken.mockResolvedValue({
        iss: ISSUER,
        aud: "aimer-web",
        sub: "user-route-1",
        aiceId: AICE_ID,
        customerIds: ["ext-route-a"],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        jti,
      });

      const jsonString =
        '{"hello":"world","schema_version":"0.0-stub","event_count":1}';
      const expectedHash = createHash("sha256")
        .update(new TextEncoder().encode(jsonString))
        .digest("base64url");

      const envelope = await signEnvelope({
        payloadHash: expectedHash,
        contextJti: jti,
        customerIds: ["ext-route-a"],
        eventCount: 1,
        schemaVersion: "0.0-stub",
      });

      const form = new FormData();
      form.append("context_token", "valid-jwt");
      form.append("events_envelope", envelope);
      form.append("events_data", jsonString); // String text part — the new branch

      const res = await callPOST(makeBridgeRequest(form));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain(
        "/api/auth/sign-in?flow=bridge",
      );

      // Real pending_connections insert
      const pending = await pool.query<{
        connection_id: string;
        jti: string;
        aice_id: string;
        customer_ids: string[];
        sub: string;
      }>(
        `SELECT connection_id, jti, aice_id, customer_ids, sub
         FROM pending_connections WHERE jti = $1`,
        [jti],
      );
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0].aice_id).toBe(AICE_ID);
      expect(pending.rows[0].customer_ids).toEqual(["ext-route-a"]);

      // Real staged_event_payloads insert with the bytes from the text
      // form part — payload_hash equals SHA-256 of the exact UTF-8 string.
      const staged = await pool.query<{
        payload_hash: string;
        event_count: number;
        schema_version: string;
        aice_id: string;
      }>(
        `SELECT payload_hash, event_count, schema_version, aice_id
         FROM staged_event_payloads WHERE connection_id = $1`,
        [pending.rows[0].connection_id],
      );
      expect(staged.rows).toHaveLength(1);
      expect(staged.rows[0].payload_hash).toBe(expectedHash);
      expect(staged.rows[0].event_count).toBe(1);
      expect(staged.rows[0].schema_version).toBe("0.0-stub");
      expect(staged.rows[0].aice_id).toBe(AICE_ID);
    });

    it("size cap is enforced after string→bytes conversion (BRIDGE_MAX_PAYLOAD_BYTES)", async () => {
      const jti = `route-jti-cap-${Date.now()}`;
      mockVerifyContextToken.mockResolvedValue({
        iss: ISSUER,
        aud: "aimer-web",
        sub: "user-route-cap",
        aiceId: AICE_ID,
        customerIds: ["ext-route-a"],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        jti,
      });

      const jsonString = '{"too":"big-for-the-cap"}';
      const hash = createHash("sha256")
        .update(new TextEncoder().encode(jsonString))
        .digest("base64url");
      const envelope = await signEnvelope({
        payloadHash: hash,
        contextJti: jti,
        customerIds: ["ext-route-a"],
        eventCount: 0,
        schemaVersion: "0.0-stub",
      });

      vi.stubEnv("BRIDGE_MAX_PAYLOAD_BYTES", "10");
      try {
        const form = new FormData();
        form.append("context_token", "valid-jwt");
        form.append("events_envelope", envelope);
        form.append("events_data", jsonString);

        const res = await callPOST(makeBridgeRequest(form));
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain("Invalid events envelope");
      } finally {
        vi.unstubAllEnvs();
      }

      // No pending or staged rows for this jti — verifier rejected before insert.
      const pending = await pool.query(
        `SELECT 1 FROM pending_connections WHERE jti = $1`,
        [jti],
      );
      expect(pending.rows).toHaveLength(0);
    });
  },
);
