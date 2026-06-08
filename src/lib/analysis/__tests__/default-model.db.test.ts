import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HttpError } from "../../auth/errors";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  clearCustomerDefaultModel,
  clearGlobalDefaultModel,
  GLOBAL_DEFAULT_MODEL_KEY,
  readCustomerDefaultModel,
  resolveDefaultModel,
  setCustomerDefaultModel,
  setGlobalDefaultModel,
} from "../default-model";
import { __resetModelCatalogForTest } from "../model-catalog";
import { seedRealReportJobs } from "../report-worker";
import { seedRealStoryJobs } from "../story-worker";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1473;

// Env default is openai/gpt-4o (always in the catalog). The catalog also
// names two extra allowed pairs so global / per-customer values resolve;
// `bad/model` is intentionally NOT in the catalog (invalid-value tests).
const ENV_DEFAULT = { modelName: "openai", model: "gpt-4o" };
const GLOBAL_PAIR = { modelName: "anthropic", model: "claude-3-5-sonnet" };
const CUSTOMER_PAIR = { modelName: "openai", model: "gpt-5.5" };
const INVALID_PAIR = { modelName: "bad", model: "model" };

describe.skipIf(!hasPostgres)("resolveDefaultModel + services (DB)", () => {
  let pool: Pool;
  let dbName: string;

  let customerId: string;
  let otherCustomerId: string;
  let analystAccountId: string; // analyst assigned to customerId
  let unassignedAnalystId: string; // analyst, not assigned to customerId
  let managerAccountId: string;
  let userAccountId: string;
  let adminAccountId: string;

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

  // Remove any per-customer / global state between tests for isolation.
  async function resetState(): Promise<void> {
    await pool.query(`DELETE FROM customer_default_model`);
    await pool.query(`DELETE FROM system_settings WHERE key = $1`, [
      GLOBAL_DEFAULT_MODEL_KEY,
    ]);
  }

  beforeAll(async () => {
    process.env.ANALYSIS_MODEL_CATALOG = JSON.stringify([
      { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
      { modelName: "anthropic", model: "claude-3-5-sonnet", label: "Claude" },
      { modelName: "openai", model: "gpt-5.5", label: "OpenAI GPT-5.5" },
    ]);
    __resetModelCatalogForTest();

    const result = await createTestDatabase("default_model", "auth");
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

    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles WHERE name IN ('User', 'Manager', 'Analyst')`,
    );
    const roleId = (name: string) =>
      roles.rows.find((r) => r.name === name)?.id as number;

    const c1 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('dm-cust', 'DM Customer', 'active') RETURNING id`,
    );
    customerId = c1.rows[0].id;
    const c2 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('dm-other', 'DM Other', 'active') RETURNING id`,
    );
    otherCustomerId = c2.rows[0].id;

    const mkAccount = async (
      sub: string,
      opts: { analyst_eligible?: boolean; admin_eligible?: boolean } = {},
    ) => {
      const row = await pool.query<{ id: string }>(
        `INSERT INTO accounts
           (oidc_issuer, oidc_subject, username, display_name,
            analyst_eligible, admin_eligible)
         VALUES ('test', $1, $1, $1, $2, $3) RETURNING id`,
        [sub, opts.analyst_eligible ?? false, opts.admin_eligible ?? false],
      );
      return row.rows[0].id;
    };

    analystAccountId = await mkAccount("dm-analyst", {
      analyst_eligible: true,
    });
    unassignedAnalystId = await mkAccount("dm-analyst-unassigned", {
      analyst_eligible: true,
    });
    managerAccountId = await mkAccount("dm-manager");
    userAccountId = await mkAccount("dm-user");
    adminAccountId = await mkAccount("dm-admin", { admin_eligible: true });

    // Manager + User memberships on customerId (to prove they are denied
    // despite having a membership role).
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [managerAccountId, customerId, roleId("Manager")],
    );
    await pool.query(
      `INSERT INTO account_customer_memberships (account_id, customer_id, role_id)
       VALUES ($1, $2, $3)`,
      [userAccountId, customerId, roleId("User")],
    );

    // Analyst assigned to customerId only.
    await pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
       VALUES ($1, $2, $3)`,
      [analystAccountId, customerId, adminAccountId],
    );
    await pool.query(
      `INSERT INTO analyst_customer_assignments (account_id, customer_id, assigned_by)
       VALUES ($1, $2, $3)`,
      [unassignedAnalystId, otherCustomerId, adminAccountId],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
    __resetModelCatalogForTest();
  });

  // -- Resolution order (three tiers) --------------------------------------

  describe("resolution order", () => {
    it("falls back to env when no DB tiers are set", async () => {
      await resetState();
      const pair = await resolveDefaultModel(customerId, pool);
      expect(pair).toEqual(ENV_DEFAULT);
    });

    it("uses the admin-set global default over env", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      const pair = await resolveDefaultModel(customerId, pool);
      expect(pair).toEqual(GLOBAL_PAIR);
    });

    it("uses the per-customer override over global and env", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await withClient((c) =>
        setCustomerDefaultModel(
          c,
          "general",
          analystAccountId,
          customerId,
          CUSTOMER_PAIR,
        ),
      );
      expect(await resolveDefaultModel(customerId, pool)).toEqual(
        CUSTOMER_PAIR,
      );
      // Other customer (no override) still sees the global default.
      expect(await resolveDefaultModel(otherCustomerId, pool)).toEqual(
        GLOBAL_PAIR,
      );
    });
  });

  // -- Defensive fallback on stale / invalid stored values -----------------

  describe("invalid stored values (resolver defensive fallback)", () => {
    it("skips an invalid per-customer override and uses global", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      // Write an invalid override directly (bypassing the validating setter).
      await pool.query(
        `INSERT INTO customer_default_model
           (customer_id, model_name, model, updated_by)
         VALUES ($1, $2, $3, $4)`,
        [
          customerId,
          INVALID_PAIR.modelName,
          INVALID_PAIR.model,
          adminAccountId,
        ],
      );
      expect(await resolveDefaultModel(customerId, pool)).toEqual(GLOBAL_PAIR);
    });

    it("skips an invalid global default and uses env", async () => {
      await resetState();
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)`,
        [GLOBAL_DEFAULT_MODEL_KEY, JSON.stringify(INVALID_PAIR)],
      );
      expect(await resolveDefaultModel(customerId, pool)).toEqual(ENV_DEFAULT);
    });
  });

  // -- Setter validation (block invalid at save) ---------------------------

  describe("setter catalog validation", () => {
    it("rejects an out-of-catalog pair with 422", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "admin",
            adminAccountId,
            customerId,
            INVALID_PAIR,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        withClient((c) =>
          setGlobalDefaultModel(c, adminAccountId, INVALID_PAIR),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("rejects a malformed body with 400", async () => {
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(c, "admin", adminAccountId, customerId, {
            modelName: "openai",
          }),
        ),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  // -- Clear / reset to global ---------------------------------------------

  describe("clear / reset", () => {
    it("clearing a per-customer override reverts to the global default", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await withClient((c) =>
        setCustomerDefaultModel(
          c,
          "general",
          analystAccountId,
          customerId,
          CUSTOMER_PAIR,
        ),
      );
      expect(await resolveDefaultModel(customerId, pool)).toEqual(
        CUSTOMER_PAIR,
      );

      const res = await withClient((c) =>
        clearCustomerDefaultModel(c, "general", analystAccountId, customerId),
      );
      expect(res.cleared).toBe(true);
      expect(await resolveDefaultModel(customerId, pool)).toEqual(GLOBAL_PAIR);
    });

    it("clearing the global default reverts to env", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await withClient((c) => clearGlobalDefaultModel(c, adminAccountId));
      expect(await resolveDefaultModel(customerId, pool)).toEqual(ENV_DEFAULT);
    });
  });

  // -- readCustomerDefaultModel view (override + effective + source) -------

  describe("readCustomerDefaultModel", () => {
    it("reports source=env / global / customer", async () => {
      await resetState();
      let view = await withClient((c) =>
        readCustomerDefaultModel(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({ override: null, source: "env" });

      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      view = await withClient((c) =>
        readCustomerDefaultModel(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({
        override: null,
        effective: GLOBAL_PAIR,
        source: "global",
      });

      await withClient((c) =>
        setCustomerDefaultModel(
          c,
          "admin",
          adminAccountId,
          customerId,
          CUSTOMER_PAIR,
        ),
      );
      view = await withClient((c) =>
        readCustomerDefaultModel(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({
        override: CUSTOMER_PAIR,
        effective: CUSTOMER_PAIR,
        source: "customer",
      });
    });
  });

  // -- Permission matrix ----------------------------------------------------

  describe("permission matrix (per-customer override)", () => {
    it("Analyst assigned to the customer may set it", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "general",
            analystAccountId,
            customerId,
            CUSTOMER_PAIR,
          ),
        ),
      ).resolves.toMatchObject({ changed: true });
    });

    it("Analyst NOT assigned to the customer is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "general",
            unassignedAnalystId,
            customerId,
            CUSTOMER_PAIR,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("Manager is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "general",
            managerAccountId,
            customerId,
            CUSTOMER_PAIR,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("User is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "general",
            userAccountId,
            customerId,
            CUSTOMER_PAIR,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("System Administrator (admin context) may set any customer", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setCustomerDefaultModel(
            c,
            "admin",
            adminAccountId,
            otherCustomerId,
            CUSTOMER_PAIR,
          ),
        ),
      ).resolves.toMatchObject({ changed: true });
    });
  });

  // -- Seeding query resolution (story worker) -----------------------------
  // `seedRealStoryJobs` reimplements the three-tier resolution IN SQL
  // (LEFT JOIN customer_default_model + the `system_settings` JSON
  // extraction + COALESCE(override, global, env)), independent of
  // `resolveDefaultModel` — but, like the resolver, it filters every DB
  // tier against the catalog (passed in as JSON) so a stale/invalid stored
  // value is skipped rather than seeded (#473 review round 1). These cases
  // prove the seeded `story_analysis_job` row carries the resolved default
  // for each tier and that stale values fall through, so the seeding SQL and
  // the resolver cannot silently drift (Scope §4).
  describe("seedRealStoryJobs resolution", () => {
    async function seedReadyState(cid: string, storyId: number): Promise<void> {
      await pool.query(
        `INSERT INTO story_analysis_state (customer_id, story_id, status)
         VALUES ($1, $2, 'ready')
         ON CONFLICT (customer_id, story_id) DO UPDATE SET status = 'ready'`,
        [cid, storyId],
      );
    }
    async function seededJobModel(
      cid: string,
      storyId: number,
    ): Promise<{ model_name: string; model: string } | null> {
      const res = await pool.query<{ model_name: string; model: string }>(
        `SELECT model_name, model FROM story_analysis_job
          WHERE customer_id = $1 AND story_id = $2::bigint`,
        [cid, storyId],
      );
      return res.rows[0] ?? null;
    }
    // story_analysis_job FKs story_analysis_state, so clear jobs first.
    async function resetSeed(): Promise<void> {
      await pool.query(`DELETE FROM story_analysis_job`);
      await pool.query(`DELETE FROM story_analysis_state`);
    }

    it("seeds the env default when no DB tier is set", async () => {
      await resetState();
      await resetSeed();
      await seedReadyState(customerId, 1);
      await withClient((c) => seedRealStoryJobs(c, 100));
      expect(await seededJobModel(customerId, 1)).toEqual({
        model_name: ENV_DEFAULT.modelName,
        model: ENV_DEFAULT.model,
      });
    });

    it("seeds the admin-set global default over env", async () => {
      await resetState();
      await resetSeed();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await seedReadyState(customerId, 2);
      await withClient((c) => seedRealStoryJobs(c, 100));
      expect(await seededJobModel(customerId, 2)).toEqual({
        model_name: GLOBAL_PAIR.modelName,
        model: GLOBAL_PAIR.model,
      });
    });

    it("seeds the per-customer override; an unconfigured peer gets global", async () => {
      await resetState();
      await resetSeed();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await withClient((c) =>
        setCustomerDefaultModel(
          c,
          "admin",
          adminAccountId,
          customerId,
          CUSTOMER_PAIR,
        ),
      );
      await seedReadyState(customerId, 3);
      await seedReadyState(otherCustomerId, 3);
      await withClient((c) => seedRealStoryJobs(c, 100));
      // The overridden customer seeds at its override; the peer with no
      // override falls back to the admin-set global default.
      expect(await seededJobModel(customerId, 3)).toEqual({
        model_name: CUSTOMER_PAIR.modelName,
        model: CUSTOMER_PAIR.model,
      });
      expect(await seededJobModel(otherCustomerId, 3)).toEqual({
        model_name: GLOBAL_PAIR.modelName,
        model: GLOBAL_PAIR.model,
      });
    });

    // The seeding SQL must mirror the resolver's DEFENSIVE skip of a
    // stale/invalid stored value (#473 review round 1) — otherwise the
    // worker would seed jobs under a pair the page/coverage resolver would
    // itself skip, making the two disagree.
    it("skips a stale (out-of-catalog) per-customer override and seeds global", async () => {
      await resetState();
      await resetSeed();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      // Write an out-of-catalog override directly (bypassing the setter, as
      // a catalog change after save or a raw DB write would produce).
      await pool.query(
        `INSERT INTO customer_default_model
           (customer_id, model_name, model, updated_by)
         VALUES ($1, $2, $3, $4)`,
        [
          customerId,
          INVALID_PAIR.modelName,
          INVALID_PAIR.model,
          adminAccountId,
        ],
      );
      await seedReadyState(customerId, 4);
      await withClient((c) => seedRealStoryJobs(c, 100));
      expect(await seededJobModel(customerId, 4)).toEqual({
        model_name: GLOBAL_PAIR.modelName,
        model: GLOBAL_PAIR.model,
      });
    });

    it("skips a partial/invalid global default and seeds env (no mixed pair)", async () => {
      await resetState();
      await resetSeed();
      // A partial global JSON (missing `model`) would, under a naive
      // per-column COALESCE, mix the global modelName with the env model.
      // The catalog-validated CTE must reject it whole and fall to env.
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)`,
        [GLOBAL_DEFAULT_MODEL_KEY, JSON.stringify({ modelName: "anthropic" })],
      );
      await seedReadyState(customerId, 5);
      await withClient((c) => seedRealStoryJobs(c, 100));
      expect(await seededJobModel(customerId, 5)).toEqual({
        model_name: ENV_DEFAULT.modelName,
        model: ENV_DEFAULT.model,
      });
    });
  });

  // -- Seeding query resolution (report worker) ----------------------------
  // The report seeder reimplements the same catalog-validated three-tier
  // resolution; these cases prove a seeded `periodic_report_job` row carries
  // the resolved default and that stale/invalid stored values are skipped
  // exactly as in the story seeder (#473 review round 1).
  describe("seedRealReportJobs resolution", () => {
    const PERIOD = "DAILY";
    const TZ = "UTC";
    async function seedReadyReportState(
      cid: string,
      bucketDate: string,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO periodic_report_state
           (customer_id, period, bucket_date, tz, status)
         VALUES ($1, $2, $3::date, $4, 'ready')
         ON CONFLICT (customer_id, period, bucket_date, tz)
         DO UPDATE SET status = 'ready'`,
        [cid, PERIOD, bucketDate, TZ],
      );
    }
    async function seededReportModel(
      cid: string,
      bucketDate: string,
    ): Promise<{ model_name: string; model: string } | null> {
      const res = await pool.query<{ model_name: string; model: string }>(
        `SELECT DISTINCT model_name, model FROM periodic_report_job
          WHERE customer_id = $1 AND period = $2 AND bucket_date = $3::date`,
        [cid, PERIOD, bucketDate],
      );
      return res.rows[0] ?? null;
    }
    // periodic_report_job FKs periodic_report_state, so clear jobs first.
    async function resetReportSeed(): Promise<void> {
      await pool.query(`DELETE FROM periodic_report_job`);
      await pool.query(`DELETE FROM periodic_report_state`);
    }

    it("seeds the per-customer override over global and env", async () => {
      await resetState();
      await resetReportSeed();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await withClient((c) =>
        setCustomerDefaultModel(
          c,
          "admin",
          adminAccountId,
          customerId,
          CUSTOMER_PAIR,
        ),
      );
      await seedReadyReportState(customerId, "2026-01-01");
      await withClient((c) => seedRealReportJobs(c, 100));
      expect(await seededReportModel(customerId, "2026-01-01")).toEqual({
        model_name: CUSTOMER_PAIR.modelName,
        model: CUSTOMER_PAIR.model,
      });
    });

    it("skips a stale (out-of-catalog) per-customer override and seeds global", async () => {
      await resetState();
      await resetReportSeed();
      await withClient((c) =>
        setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
      );
      await pool.query(
        `INSERT INTO customer_default_model
           (customer_id, model_name, model, updated_by)
         VALUES ($1, $2, $3, $4)`,
        [
          customerId,
          INVALID_PAIR.modelName,
          INVALID_PAIR.model,
          adminAccountId,
        ],
      );
      await seedReadyReportState(customerId, "2026-01-02");
      await withClient((c) => seedRealReportJobs(c, 100));
      expect(await seededReportModel(customerId, "2026-01-02")).toEqual({
        model_name: GLOBAL_PAIR.modelName,
        model: GLOBAL_PAIR.model,
      });
    });

    it("skips a partial/invalid global default and seeds env (no mixed pair)", async () => {
      await resetState();
      await resetReportSeed();
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)`,
        [GLOBAL_DEFAULT_MODEL_KEY, JSON.stringify({ modelName: "anthropic" })],
      );
      await seedReadyReportState(customerId, "2026-01-03");
      await withClient((c) => seedRealReportJobs(c, 100));
      expect(await seededReportModel(customerId, "2026-01-03")).toEqual({
        model_name: ENV_DEFAULT.modelName,
        model: ENV_DEFAULT.model,
      });
    });
  });

  describe("permission matrix (global default)", () => {
    it("System Administrator may set the global default", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setGlobalDefaultModel(c, adminAccountId, GLOBAL_PAIR),
        ),
      ).resolves.toEqual(GLOBAL_PAIR);
    });

    it("a non-admin account is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setGlobalDefaultModel(c, analystAccountId, GLOBAL_PAIR),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
