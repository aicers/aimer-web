import { join } from "node:path";
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

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  claimPAR,
  cleanupExpiredAnalyzeRequests,
  expireStalePAR,
  markPARConsumed,
  markPARFailed,
} from "../analyze-bridge";
import { cleanupExpiredConnections } from "../bridge";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 9274;

describe.skipIf(!hasPostgres)(
  "pending_analysis_requests DB integration",
  () => {
    let pool: Pool;
    let dbName: string;

    beforeAll(async () => {
      const result = await createTestDatabase("par_db", "auth");
      pool = result.pool;
      dbName = result.dbName;

      // Ensure runtime role exists for GRANT statements in migrations.
      await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
          CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
        END IF;
      END $$
    `);

      await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool, "auth");
      await closeAdminPool();
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM pending_analysis_requests`);
      await pool.query(`DELETE FROM pending_connections`);
    });

    async function insertConnection(opts: {
      jti: string;
      expiresInterval: string;
    }): Promise<string> {
      const result = await pool.query<{ connection_id: string }>(
        `INSERT INTO pending_connections
         (jti, issuer, aice_id, customer_ids, sub, expires_at)
       VALUES ($1, 'https://aice.test', 'aice-1', ARRAY['ext-1']::text[], 'sub-1',
               NOW() + ($2::interval))
       RETURNING connection_id`,
        [opts.jti, opts.expiresInterval],
      );
      return result.rows[0].connection_id;
    }

    async function insertPAR(opts: {
      connectionId: string;
      status?: "pending" | "processing" | "consumed" | "expired" | "failed";
      expiresInterval: string;
    }): Promise<string> {
      const status = opts.status ?? "pending";
      const result = await pool.query<{ id: string }>(
        `INSERT INTO pending_analysis_requests
         (connection_id, aice_id, external_key, event_key,
          lang, model_name, model, force,
          payload, wrapped_dek, payload_hash,
          status, expires_at)
       VALUES ($1, 'aice-1', 'ext-1', '42',
               'KOREAN', 'gpt', 'v1', false,
               '\\x00'::bytea, 'wrapped-dek', 'hash-1',
               $2, NOW() + ($3::interval))
       RETURNING id`,
        [opts.connectionId, status, opts.expiresInterval],
      );
      return result.rows[0].id;
    }

    describe("connection_id UNIQUE — defence-in-depth", () => {
      it("rejects a second PAR INSERT against the same connection_id", async () => {
        const cid = await insertConnection({
          jti: "jti-defense-1",
          expiresInterval: "1 hour",
        });
        await insertPAR({ connectionId: cid, expiresInterval: "1 hour" });
        await expect(
          insertPAR({ connectionId: cid, expiresInterval: "1 hour" }),
        ).rejects.toThrow(/duplicate key|pending_analysis_requests/);
      });
    });

    describe("FK to pending_connections", () => {
      it("rejects PAR insert with a missing connection_id (FK violation)", async () => {
        // Random UUID that doesn't exist in pending_connections.
        const fakeConnectionId = "00000000-0000-4000-8000-000000000000";
        await expect(
          insertPAR({
            connectionId: fakeConnectionId,
            expiresInterval: "1 hour",
          }),
        ).rejects.toThrow(/foreign key|pending_connections/);
      });

      it("blocks parent DELETE while child PAR row exists (FK ordering)", async () => {
        const cid = await insertConnection({
          jti: "jti-ordering-1",
          expiresInterval: "-25 hours", // past grace window
        });
        await insertPAR({
          connectionId: cid,
          status: "consumed",
          expiresInterval: "-25 hours",
        });
        // cleanupExpiredConnections runs first — must fail with FK
        // violation while the child PAR row still exists in the 24h
        // grace window. This is why installAuthPoolCleanup must run
        // cleanupExpiredAnalyzeRequests before cleanupExpiredConnections.
        await expect(cleanupExpiredConnections(pool)).rejects.toThrow(
          /foreign key|pending_analysis_requests/,
        );
      });

      it("parent DELETE succeeds after child DELETE in the same tick", async () => {
        const cid = await insertConnection({
          jti: "jti-ordering-2",
          expiresInterval: "-25 hours",
        });
        await insertPAR({
          connectionId: cid,
          status: "consumed",
          expiresInterval: "-25 hours",
        });
        // Correct order: PAR cleanup deletes the child row, then
        // connections cleanup deletes the parent row.
        const parDeleted = await cleanupExpiredAnalyzeRequests(pool);
        expect(parDeleted).toBe(1);
        const connDeleted = await cleanupExpiredConnections(pool);
        expect(connDeleted).toBe(1);
      });
    });

    describe("claimPAR CAS pending → processing", () => {
      it("first claim returns true and flips status to processing", async () => {
        const cid = await insertConnection({
          jti: "jti-claim-1",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "1 hour",
        });
        const ok = await claimPAR(pool, parId);
        expect(ok).toBe(true);
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("processing");
      });

      it("second concurrent claim returns false (no second pending → processing)", async () => {
        const cid = await insertConnection({
          jti: "jti-claim-2",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "1 hour",
        });
        // Both calls race; CAS guarantees exactly one transition.
        const [a, b] = await Promise.all([
          claimPAR(pool, parId),
          claimPAR(pool, parId),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
      });

      it("claim on non-pending row returns false", async () => {
        const cid = await insertConnection({
          jti: "jti-claim-3",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "consumed",
          expiresInterval: "1 hour",
        });
        const ok = await claimPAR(pool, parId);
        expect(ok).toBe(false);
      });

      it("claim on pending row past expires_at (cleanup has not run) returns false", async () => {
        const cid = await insertConnection({
          jti: "jti-claim-4",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "-1 minute",
        });
        const ok = await claimPAR(pool, parId);
        expect(ok).toBe(false);
        // Row is unchanged — claim refused, cleanup will sweep it later.
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("pending");
      });
    });

    describe("expireStalePAR", () => {
      it("flips a pending row past expires_at to expired (true)", async () => {
        const cid = await insertConnection({
          jti: "jti-expire-stale-1",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "-1 minute",
        });
        const ok = await expireStalePAR(pool, parId);
        expect(ok).toBe(true);
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("expired");
      });

      it("does NOT flip a pending row still within TTL (false)", async () => {
        const cid = await insertConnection({
          jti: "jti-expire-stale-2",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "1 hour",
        });
        const ok = await expireStalePAR(pool, parId);
        expect(ok).toBe(false);
      });

      it("does NOT flip a terminal row even past expires_at (false)", async () => {
        const cid = await insertConnection({
          jti: "jti-expire-stale-3",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "consumed",
          expiresInterval: "-1 minute",
        });
        const ok = await expireStalePAR(pool, parId);
        expect(ok).toBe(false);
      });
    });

    describe("markPARConsumed / markPARFailed accept processing", () => {
      it("processing → consumed via markPARConsumed", async () => {
        const cid = await insertConnection({
          jti: "jti-consume-1",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "processing",
          expiresInterval: "1 hour",
        });
        const ok = await markPARConsumed(pool, parId, "http://example/view");
        expect(ok).toBe(true);
        const row = await pool.query<{ status: string; view_url: string }>(
          `SELECT status, view_url FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("consumed");
        expect(row.rows[0].view_url).toBe("http://example/view");
      });

      it("processing → failed via markPARFailed", async () => {
        const cid = await insertConnection({
          jti: "jti-fail-1",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "processing",
          expiresInterval: "1 hour",
        });
        const ok = await markPARFailed(pool, parId, "aimer_unavailable");
        expect(ok).toBe(true);
        const row = await pool.query<{ status: string; failure_code: string }>(
          `SELECT status, failure_code FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("failed");
        expect(row.rows[0].failure_code).toBe("aimer_unavailable");
      });
    });

    describe("cleanupExpiredAnalyzeRequests two-phase", () => {
      it("flips stale processing rows past expires_at to expired", async () => {
        const cid = await insertConnection({
          jti: "jti-stale-processing",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "processing",
          expiresInterval: "-1 second",
        });
        await cleanupExpiredAnalyzeRequests(pool);
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("expired");
      });
    });

    describe("cleanupExpiredAnalyzeRequests two-phase (pending + grace)", () => {
      it("flips pending rows past expires_at to 'expired'", async () => {
        const cid = await insertConnection({
          jti: "jti-expire-1",
          expiresInterval: "1 hour", // parent still alive
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "-1 second", // child expired
        });
        const deleted = await cleanupExpiredAnalyzeRequests(pool);
        expect(deleted).toBe(0); // not past grace window yet
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("expired");
      });

      it("does not flip rows that are still within expires_at", async () => {
        const cid = await insertConnection({
          jti: "jti-expire-2",
          expiresInterval: "1 hour",
        });
        const parId = await insertPAR({
          connectionId: cid,
          status: "pending",
          expiresInterval: "1 hour",
        });
        await cleanupExpiredAnalyzeRequests(pool);
        const row = await pool.query<{ status: string }>(
          `SELECT status FROM pending_analysis_requests WHERE id = $1`,
          [parId],
        );
        expect(row.rows[0].status).toBe("pending");
      });

      it("deletes rows past the 24h grace window (regardless of terminal status)", async () => {
        // consumed past grace
        const cid1 = await insertConnection({
          jti: "jti-grace-1",
          expiresInterval: "-25 hours",
        });
        await insertPAR({
          connectionId: cid1,
          status: "consumed",
          expiresInterval: "-25 hours",
        });
        // failed past grace
        const cid2 = await insertConnection({
          jti: "jti-grace-2",
          expiresInterval: "-25 hours",
        });
        await insertPAR({
          connectionId: cid2,
          status: "failed",
          expiresInterval: "-25 hours",
        });
        // expired past grace
        const cid3 = await insertConnection({
          jti: "jti-grace-3",
          expiresInterval: "-25 hours",
        });
        await insertPAR({
          connectionId: cid3,
          status: "expired",
          expiresInterval: "-25 hours",
        });

        const deleted = await cleanupExpiredAnalyzeRequests(pool);
        expect(deleted).toBe(3);
      });
    });
  },
);
