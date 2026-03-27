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
import { HttpError } from "../errors";
import {
  clearSessionPolicyCache,
  DEFAULT_POLICY,
  MIN_ABSOLUTE_MINUTES,
  MIN_IDLE_MINUTES,
  readSessionPolicy,
  updateSessionPolicy,
} from "../session-policy";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1031;

describe.skipIf(!hasPostgres)(
  "readSessionPolicy / updateSessionPolicy (DB integration)",
  () => {
    let pool: Pool;
    let dbName: string;

    let adminAccountId: string;
    let nonAdminAccountId: string;

    async function withClient<T>(
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }

    beforeAll(async () => {
      const result = await createTestDatabase("sesspol", "auth");
      pool = result.pool;
      dbName = result.dbName;

      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimer_auth') THEN
            CREATE ROLE aimer_auth LOGIN PASSWORD 'changeme';
          END IF;
        END $$
      `);

      await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);

      // Create admin-eligible account
      const admin = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, admin_eligible)
         VALUES ('test-issuer', 'sp-admin-001', 'spadmin', 'SP Admin', true)
         RETURNING id`,
      );
      adminAccountId = admin.rows[0].id;

      // Create non-admin account
      const user = await pool.query<{ id: string }>(
        `INSERT INTO accounts (oidc_issuer, oidc_subject, username, display_name, admin_eligible)
         VALUES ('test-issuer', 'sp-user-001', 'spuser', 'SP User', false)
         RETURNING id`,
      );
      nonAdminAccountId = user.rows[0].id;
    });

    afterAll(async () => {
      clearSessionPolicyCache();
      await dropTestDatabase(dbName, pool, "auth");
      await closeAdminPool();
    });

    // ----- readSessionPolicy -----

    it("returns default policy when no row exists", async () => {
      const policy = await withClient((client) =>
        readSessionPolicy(client, adminAccountId),
      );
      expect(policy).toEqual(DEFAULT_POLICY);
    });

    it("rejects non-admin accounts", async () => {
      await expect(
        withClient((client) => readSessionPolicy(client, nonAdminAccountId)),
      ).rejects.toThrow(HttpError);
    });

    // ----- updateSessionPolicy -----

    it("persists and returns the new policy", async () => {
      const input = {
        general: { idle_timeout_minutes: 60, absolute_timeout_minutes: 960 },
        admin: { idle_timeout_minutes: 10, absolute_timeout_minutes: 120 },
      };

      const result = await withClient((client) =>
        updateSessionPolicy(client, adminAccountId, input),
      );

      expect(result).toEqual(input);

      // Verify persisted
      const persisted = await withClient((client) =>
        readSessionPolicy(client, adminAccountId),
      );
      expect(persisted).toEqual(input);
    });

    it("rejects idle_timeout_minutes below floor", async () => {
      const input = {
        general: {
          idle_timeout_minutes: MIN_IDLE_MINUTES - 1,
          absolute_timeout_minutes: 480,
        },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      };

      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, input),
        ),
      ).rejects.toThrow(
        `general.idle_timeout_minutes must be at least ${MIN_IDLE_MINUTES}`,
      );
    });

    it("rejects absolute_timeout_minutes below floor", async () => {
      const input = {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: {
          idle_timeout_minutes: 15,
          absolute_timeout_minutes: MIN_ABSOLUTE_MINUTES - 1,
        },
      };

      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, input),
        ),
      ).rejects.toThrow(
        `admin.absolute_timeout_minutes must be at least ${MIN_ABSOLUTE_MINUTES}`,
      );
    });

    it("rejects non-integer timeout values", async () => {
      const input = {
        general: {
          idle_timeout_minutes: 30.5,
          absolute_timeout_minutes: 480,
        },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      };

      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, input),
        ),
      ).rejects.toThrow("general.idle_timeout_minutes must be an integer");
    });

    it("rejects missing general or admin context", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: {
              idle_timeout_minutes: 30,
              absolute_timeout_minutes: 480,
            },
          }),
        ),
      ).rejects.toThrow("Both general and admin policy contexts are required");
    });

    it("rejects non-admin accounts for update", async () => {
      const input = {
        general: { idle_timeout_minutes: 30, absolute_timeout_minutes: 480 },
        admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
      };

      await expect(
        withClient((client) =>
          updateSessionPolicy(client, nonAdminAccountId, input),
        ),
      ).rejects.toThrow(HttpError);
    });

    it("accepts values exactly at the floor", async () => {
      const input = {
        general: {
          idle_timeout_minutes: MIN_IDLE_MINUTES,
          absolute_timeout_minutes: MIN_ABSOLUTE_MINUTES,
        },
        admin: {
          idle_timeout_minutes: MIN_IDLE_MINUTES,
          absolute_timeout_minutes: MIN_ABSOLUTE_MINUTES,
        },
      };

      const result = await withClient((client) =>
        updateSessionPolicy(client, adminAccountId, input),
      );
      expect(result).toEqual(input);
    });

    // ----- input shape validation -----

    it("rejects null input", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, null),
        ),
      ).rejects.toThrow("Request body must be a JSON object");
    });

    it("rejects array input", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, [1, 2]),
        ),
      ).rejects.toThrow("Request body must be a JSON object");
    });

    it("rejects non-object context value", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: "not-an-object",
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        ),
      ).rejects.toThrow("general must be an object");
    });

    it("rejects NaN timeout value", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: {
              idle_timeout_minutes: Number.NaN,
              absolute_timeout_minutes: 480,
            },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        ),
      ).rejects.toThrow("general.idle_timeout_minutes must be an integer");
    });

    it("rejects Infinity timeout value", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: {
              idle_timeout_minutes: Number.POSITIVE_INFINITY,
              absolute_timeout_minutes: 480,
            },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        ),
      ).rejects.toThrow("general.idle_timeout_minutes must be an integer");
    });

    it("rejects missing field within context", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: { idle_timeout_minutes: 30 },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        ),
      ).rejects.toThrow("general.absolute_timeout_minutes must be an integer");
    });

    it("rejects string timeout value", async () => {
      await expect(
        withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: {
              idle_timeout_minutes: "30",
              absolute_timeout_minutes: 480,
            },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        ),
      ).rejects.toThrow("general.idle_timeout_minutes must be an integer");
    });

    // ----- upsert behavior -----

    it("overwrites existing policy on second update", async () => {
      const first = {
        general: { idle_timeout_minutes: 20, absolute_timeout_minutes: 240 },
        admin: { idle_timeout_minutes: 10, absolute_timeout_minutes: 120 },
      };
      await withClient((client) =>
        updateSessionPolicy(client, adminAccountId, first),
      );

      const second = {
        general: { idle_timeout_minutes: 45, absolute_timeout_minutes: 720 },
        admin: { idle_timeout_minutes: 8, absolute_timeout_minutes: 90 },
      };
      await withClient((client) =>
        updateSessionPolicy(client, adminAccountId, second),
      );

      const persisted = await withClient((client) =>
        readSessionPolicy(client, adminAccountId),
      );
      expect(persisted).toEqual(second);
    });

    // ----- error status codes -----

    it("returns 403 for non-admin read", async () => {
      try {
        await withClient((client) =>
          readSessionPolicy(client, nonAdminAccountId),
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("returns 403 for non-admin update", async () => {
      try {
        await withClient((client) =>
          updateSessionPolicy(client, nonAdminAccountId, {
            general: {
              idle_timeout_minutes: 30,
              absolute_timeout_minutes: 480,
            },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it("returns 400 for floor violations", async () => {
      try {
        await withClient((client) =>
          updateSessionPolicy(client, adminAccountId, {
            general: {
              idle_timeout_minutes: 1,
              absolute_timeout_minutes: 480,
            },
            admin: { idle_timeout_minutes: 15, absolute_timeout_minutes: 120 },
          }),
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
      }
    });
  },
);
