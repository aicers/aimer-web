// Per-customer/group TI source selection (RFC 0003 F2, #598) — service-level
// integration against a real auth DB. Mirrors `default-model.db.test.ts`:
//   - three-tier resolution (subject → admin global → all-enabled),
//   - defensive fallback on stale/unknown stored ids,
//   - allowlist semantics (a source registered after a narrowed row stays
//     disabled for that subject),
//   - write validation (empty + unknown ids → 422),
//   - the per-subject permission matrix (Analyst assigned / unassigned /
//     Manager / User / Admin) and the admin-global `system-settings` grant,
//   - the read views surfaced by the routes.

import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";
import {
  registerTiSource,
  unregisterTiSource,
} from "../enrichment/sources/registry";
import {
  allEnabledSourceIds,
  clearGlobalTiSources,
  clearSubjectTiSources,
  GLOBAL_TI_SOURCES_DEFAULT_KEY,
  readGlobalTiSourcesView,
  readSubjectTiSources,
  resolveEnabledSources,
  setGlobalTiSources,
  setSubjectTiSources,
} from "../ti-sources";

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1598;

// Two shipped source ids used as the narrowed selections in these tests.
const FEODO = "abuse.ch/feodo";
const DROP = "spamhaus/drop";

describe.skipIf(!hasPostgres)("resolveEnabledSources + services (DB)", () => {
  let pool: Pool;
  let dbName: string;

  let customerId: string;
  let otherCustomerId: string;
  let analystAccountId: string; // analyst assigned to customerId
  let unassignedAnalystId: string; // analyst, not assigned to customerId
  let managerAccountId: string;
  let userAccountId: string;
  let adminAccountId: string;

  let ALL: string[];

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

  async function resetState(): Promise<void> {
    await pool.query(`DELETE FROM subject_ti_sources`);
    await pool.query(`DELETE FROM system_settings WHERE key = $1`, [
      GLOBAL_TI_SOURCES_DEFAULT_KEY,
    ]);
  }

  beforeAll(async () => {
    const result = await createTestDatabase("ti_sources", "auth");
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

    ALL = allEnabledSourceIds();

    const c1 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('ti-cust', 'TI Customer', 'active') RETURNING id`,
    );
    customerId = c1.rows[0].id;
    const c2 = await pool.query<{ id: string }>(
      `INSERT INTO customers (external_key, name, status)
       VALUES ('ti-other', 'TI Other', 'active') RETURNING id`,
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

    analystAccountId = await mkAccount("ti-analyst", {
      analyst_eligible: true,
    });
    unassignedAnalystId = await mkAccount("ti-analyst-unassigned", {
      analyst_eligible: true,
    });
    managerAccountId = await mkAccount("ti-manager");
    userAccountId = await mkAccount("ti-user");
    adminAccountId = await mkAccount("ti-admin", { admin_eligible: true });

    const roles = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM roles WHERE name IN ('User', 'Manager', 'Analyst')`,
    );
    const roleId = (name: string) =>
      roles.rows.find((r) => r.name === name)?.id as number;

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
  });

  // -- Resolution order (three tiers) --------------------------------------

  describe("resolution order", () => {
    it("falls back to all-enabled when no DB tiers are set", async () => {
      await resetState();
      expect(await resolveEnabledSources(customerId, pool)).toEqual(ALL);
    });

    it("uses the admin-set global default over all-enabled", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual([FEODO]);
    });

    it("uses the per-subject selection over global and all-enabled", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      await withClient((c) =>
        setSubjectTiSources(c, "general", analystAccountId, customerId, {
          enabledSourceIds: [DROP],
        }),
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual([DROP]);
      // Peer with no row still sees the global default.
      expect(await resolveEnabledSources(otherCustomerId, pool)).toEqual([
        FEODO,
      ]);
    });
  });

  // -- Allowlist semantics: a late-registered source stays disabled --------

  describe("allowlist semantics", () => {
    it("does NOT auto-enable a source registered after a narrowed row", async () => {
      await resetState();
      await withClient((c) =>
        setSubjectTiSources(c, "general", analystAccountId, customerId, {
          enabledSourceIds: [FEODO],
        }),
      );
      // Register a brand-new source AFTER the row was written.
      registerTiSource({
        sourcePolicyId: "test/late-source",
        label: "Late Source",
        entityTypes: ["IP"],
        deterministicCoverage: true,
        maxAge: 1000,
        floorEligible: false,
        parse: "ip-blocklist",
        entityType: "IP",
        hitType: "deterministic_ioc",
      });
      try {
        // The narrowed subject does NOT pick up the new source.
        expect(await resolveEnabledSources(customerId, pool)).toEqual([FEODO]);
        // A subject with no row enriches against every source, including the
        // newly registered one (default = all enabled).
        expect(await resolveEnabledSources(otherCustomerId, pool)).toContain(
          "test/late-source",
        );
      } finally {
        unregisterTiSource("test/late-source");
      }
    });
  });

  // -- Defensive fallback on stale / unknown stored values -----------------

  describe("stale / unknown stored ids (resolver defensive fallback)", () => {
    it("drops an unknown id from a per-subject row but keeps the known ones", async () => {
      await resetState();
      await pool.query(
        `INSERT INTO subject_ti_sources
           (subject_id, enabled_source_ids, updated_by)
         VALUES ($1, $2::jsonb, $3)`,
        [customerId, JSON.stringify([FEODO, "ghost/unknown"]), adminAccountId],
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual([FEODO]);
    });

    it("falls through to global when every per-subject id is unknown", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [DROP] }),
      );
      await pool.query(
        `INSERT INTO subject_ti_sources
           (subject_id, enabled_source_ids, updated_by)
         VALUES ($1, $2::jsonb, $3)`,
        [customerId, JSON.stringify(["ghost/a", "ghost/b"]), adminAccountId],
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual([DROP]);
    });

    it("falls through to all-enabled when every global id is unknown", async () => {
      await resetState();
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)`,
        [GLOBAL_TI_SOURCES_DEFAULT_KEY, JSON.stringify(["ghost/a"])],
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual(ALL);
    });
  });

  // -- Write validation (empty + unknown → 422) ----------------------------

  describe("write validation", () => {
    it("rejects an empty enabledSourceIds with 422 (per-subject + global)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "admin", adminAccountId, customerId, {
            enabledSourceIds: [],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        withClient((c) =>
          setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [] }),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("rejects an unknown sourcePolicyId with 422 (per-subject + global)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "admin", adminAccountId, customerId, {
            enabledSourceIds: [FEODO, "ghost/unknown"],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        withClient((c) =>
          setGlobalTiSources(c, adminAccountId, {
            enabledSourceIds: ["ghost/unknown"],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("rejects a malformed body with 400", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "admin", adminAccountId, customerId, {
            notTheRightKey: true,
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // -- Clear / reset to default --------------------------------------------

  describe("clear / reset", () => {
    it("clearing a per-subject selection reverts to the global default", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      await withClient((c) =>
        setSubjectTiSources(c, "general", analystAccountId, customerId, {
          enabledSourceIds: [DROP],
        }),
      );
      expect(await resolveEnabledSources(customerId, pool)).toEqual([DROP]);

      const res = await withClient((c) =>
        clearSubjectTiSources(c, "general", analystAccountId, customerId),
      );
      expect(res.cleared).toBe(true);
      expect(await resolveEnabledSources(customerId, pool)).toEqual([FEODO]);
    });

    it("clearing the global default reverts to all-enabled", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      await withClient((c) => clearGlobalTiSources(c, adminAccountId));
      expect(await resolveEnabledSources(customerId, pool)).toEqual(ALL);
    });
  });

  // -- readSubjectTiSources view (stored + effective + source) -------------

  describe("readSubjectTiSources", () => {
    it("reports source=default / global / subject", async () => {
      await resetState();
      let view = await withClient((c) =>
        readSubjectTiSources(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({ stored: null, source: "default" });
      expect(view.effective).toEqual(ALL);

      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      view = await withClient((c) =>
        readSubjectTiSources(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({
        stored: null,
        effective: [FEODO],
        source: "global",
      });

      await withClient((c) =>
        setSubjectTiSources(c, "admin", adminAccountId, customerId, {
          enabledSourceIds: [DROP],
        }),
      );
      view = await withClient((c) =>
        readSubjectTiSources(c, "admin", adminAccountId, customerId),
      );
      expect(view).toMatchObject({
        stored: [DROP],
        effective: [DROP],
        source: "subject",
      });
    });

    it("404s on a nonexistent / non-customer subject (admin context)", async () => {
      await resetState();
      const bogus = "00000000-0000-0000-0000-0000000000ff";
      await expect(
        withClient((c) =>
          readSubjectTiSources(c, "admin", adminAccountId, bogus),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // -- readGlobalTiSourcesView (stored vs effective, staleness) ------------

  describe("readGlobalTiSourcesView", () => {
    it("reports active=false / source=default when unset", async () => {
      await resetState();
      const view = await withClient((c) => readGlobalTiSourcesView(c));
      expect(view).toMatchObject({
        stored: null,
        active: false,
        source: "default",
      });
      expect(view.effective).toEqual(ALL);
    });

    it("reports a valid global as active with source=global", async () => {
      await resetState();
      await withClient((c) =>
        setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
      );
      const view = await withClient((c) => readGlobalTiSourcesView(c));
      expect(view).toMatchObject({
        stored: [FEODO],
        active: true,
        effective: [FEODO],
        source: "global",
      });
    });

    it("surfaces an all-stale global as inactive with the all-enabled effective", async () => {
      await resetState();
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())`,
        [GLOBAL_TI_SOURCES_DEFAULT_KEY, JSON.stringify(["ghost/unknown"])],
      );
      const view = await withClient((c) => readGlobalTiSourcesView(c));
      expect(view).toMatchObject({
        stored: ["ghost/unknown"],
        active: false,
        source: "default",
      });
      expect(view.effective).toEqual(ALL);
    });
  });

  // -- Permission matrix (per-subject selection) ---------------------------

  describe("permission matrix (per-subject selection)", () => {
    it("Analyst assigned to the customer may set it", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "general", analystAccountId, customerId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).resolves.toMatchObject({ changed: true });
    });

    it("Analyst NOT assigned to the customer is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "general", unassignedAnalystId, customerId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("Manager is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "general", managerAccountId, customerId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("User is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "general", userAccountId, customerId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("System Administrator (admin context) may set any customer", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setSubjectTiSources(c, "admin", adminAccountId, otherCustomerId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).resolves.toMatchObject({ changed: true });
    });
  });

  describe("permission matrix (global default)", () => {
    it("System Administrator may set the global default", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setGlobalTiSources(c, adminAccountId, { enabledSourceIds: [FEODO] }),
        ),
      ).resolves.toMatchObject({ enabledSourceIds: [FEODO] });
    });

    it("a non-admin account is denied (403)", async () => {
      await resetState();
      await expect(
        withClient((c) =>
          setGlobalTiSources(c, analystAccountId, {
            enabledSourceIds: [FEODO],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
