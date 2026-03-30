import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

const describeDb = hasPostgres ? describe : describe.skip;

describeDb("audit_logs integration", () => {
  let ownerPool: Pool;
  let dbName: string;

  /** Run a callback as the `aimer_audit` runtime role via SET ROLE. */
  async function asRuntimeRole<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await ownerPool.connect();
    try {
      await client.query("SET ROLE aimer_audit");
      return await fn(client);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  }

  beforeAll(async () => {
    const db = await createTestDatabase("audit", "audit");
    dbName = db.dbName;
    ownerPool = db.pool;

    // Run audit migrations
    const migrationsDir = join(process.cwd(), "migrations", "audit");
    await runMigrations(ownerPool, migrationsDir, 9999);

    // Create runtime role for tamper-resistance tests (SET ROLE, no login)
    await ownerPool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_audit') THEN
           CREATE ROLE aimer_audit NOLOGIN;
         END IF;
       END $$`,
    );
    await ownerPool.query("GRANT aimer_audit TO CURRENT_USER");
    await ownerPool.query("GRANT SELECT, INSERT ON audit_logs TO aimer_audit");
    await ownerPool.query(
      "GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO aimer_audit",
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, ownerPool, "audit");
    await closeAdminPool();
  });

  it("inserts and reads back an audit log entry", async () => {
    await asRuntimeRole(async (client) => {
      await client.query(
        `INSERT INTO audit_logs
           (actor_id, auth_context, action, target_type, target_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "actor-1",
          "general",
          "general.auth.sign_in_success",
          "session",
          "sid-1",
          JSON.stringify({ foo: "bar" }),
          "127.0.0.1",
        ],
      );

      const result = await client.query(
        "SELECT * FROM audit_logs WHERE actor_id = $1",
        ["actor-1"],
      );

      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];
      expect(row.action).toBe("general.auth.sign_in_success");
      expect(row.target_type).toBe("session");
      expect(row.details).toEqual({ foo: "bar" });
      expect(row.ip_address).toBe("127.0.0.1");
      expect(row.timestamp).toBeInstanceOf(Date);
    });
  });

  it("runtime role cannot UPDATE audit_logs", async () => {
    await asRuntimeRole(async (client) => {
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, target_type)
         VALUES ('tamper-test', 'general.auth.sign_in_success', 'session')`,
      );
    });

    await expect(
      asRuntimeRole((client) =>
        client.query(
          "UPDATE audit_logs SET actor_id = 'hacked' WHERE actor_id = 'tamper-test'",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("runtime role cannot DELETE from audit_logs", async () => {
    await expect(
      asRuntimeRole((client) =>
        client.query("DELETE FROM audit_logs WHERE actor_id = 'tamper-test'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("stores and retrieves correlation_id as UUID", async () => {
    const correlationId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    await asRuntimeRole(async (client) => {
      await client.query(
        `INSERT INTO audit_logs
           (actor_id, action, target_type, correlation_id)
         VALUES ($1, $2, $3, $4::uuid)`,
        ["corr-test", "bridge.connection_request", "bridge", correlationId],
      );

      const result = await client.query(
        "SELECT correlation_id FROM audit_logs WHERE actor_id = $1",
        ["corr-test"],
      );
      expect(result.rows[0].correlation_id).toBe(correlationId);
    });
  });

  it("enforces auth_context check constraint", async () => {
    await expect(
      asRuntimeRole((client) =>
        client.query(
          `INSERT INTO audit_logs (actor_id, auth_context, action, target_type)
           VALUES ('check-test', 'invalid', 'general.auth.sign_in_success', 'session')`,
        ),
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});
