// End-to-end smoke test for the redaction-engine → KEK-rotation handoff.
//
// Per issue #251 §"KEK rotation handoff": #250 covers the DB-level
// concurrency of `rewrapCustomerEvents` against synthetic UPSERTs
// (see `kek-rotation-concurrency.db.test.ts`). This test layers the
// full ingestion path on top: write a real `event_redaction_map` row
// through `ingestBaselineBatch` (engine output, not a hand-seeded
// fixture), then run `rotateAllKeks`, then re-read the row through
// the same envelope adapter and assert the entities are byte-identical
// to the pre-rotation map.

import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "../../db/__tests__/db-test-helpers";
import { runMigrations } from "../../db/migrate";

vi.mock("server-only", () => ({}));

// Envelope adapter — round-trip the map as plaintext JSON in
// `ciphertext`, encode the wrapping marker in `wrappedDek`. This lets
// us decrypt post-rotation without standing up OpenBao Transit.
vi.mock("@/lib/redaction/envelope-adapter", () => ({
  encryptRedactionMap: async (_customerId: string, map: unknown) => ({
    ciphertext: Buffer.from(JSON.stringify(map), "utf8"),
    wrappedDek: "vault:v1:map",
  }),
  decryptRedactionMap: async (_customerId: string, ciphertext: Buffer) =>
    JSON.parse(ciphertext.toString("utf8")),
}));

// `customerTransitKeyName` / `customerDbUrl` are pulled in by
// `kek-rotation.ts`. Stub them so the rotation code doesn't try to
// build a real per-customer URL; the test wires `connectCustomerDb`
// to the existing test pool directly.
vi.mock("../../db/customer-db", () => ({
  customerTransitKeyName: (id: string) => `customer-${id}`,
  customerDbUrl: () => "postgres://unused",
  getCustomerOwnerTemplateUrl: () => "postgres://unused",
}));

const { ingestBaselineBatch } = await import("@/app/api/phase2/_shared/ingest");
const { rotateAllKeks } = await import("../kek-rotation");
const { buildRangeSet, EMPTY_OWNED_DOMAIN_SET } = await import(
  "@/lib/redaction"
);

const CUSTOMER_MIGRATIONS_DIR = join(process.cwd(), "migrations", "customer");
const LOCK_ID = 1090;

const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";
const AICE_ID = "aice-rot";
const EVENT_KEY = "9100";

describe.skipIf(!hasPostgres)(
  "ingest → rotateAllKeks → decrypt round-trip",
  () => {
    let pool: Pool;
    let dbName: string;

    beforeAll(async () => {
      const result = await createTestDatabase("kek_rot_redaction");
      pool = result.pool;
      dbName = result.dbName;
      await runMigrations(pool, CUSTOMER_MIGRATIONS_DIR, LOCK_ID);
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
      await closeAdminPool();
    });

    it("rewraps the per-event DEK while preserving the decrypted entity map", async () => {
      // 1. Ingest one event through the redaction path. The payload
      //    has two redactable values (one private IP, one email) so
      //    the engine emits a non-empty map.
      const payload = {
        external_key: "ext-1",
        source_aice_id: AICE_ID,
        baseline_version: "be-rot-1",
        events: [
          {
            event_key: EVENT_KEY,
            event_time: "2026-01-02T03:04:05Z",
            kind: "dns",
            category: null,
            primary_asset: null,
            raw_score: 0.5,
            selector_tags: [],
            raw_event: { src: "10.0.0.42", user: "alice@example.com" },
            score_window_context: {
              kind_cohort_window: {
                from: "2026-01-01T00:00:00Z",
                to: "2026-01-02T00:00:00Z",
              },
              kind_cohort_size: 64,
              baseline_rank_snapshot: 0.5,
            },
            window_signals: {},
            asset_context: null,
            scoring_weights_snapshot: {},
          },
        ],
      };
      await ingestBaselineBatch(
        pool,
        payload,
        CUSTOMER_ID,
        AICE_ID,
        buildRangeSet([]),
        EMPTY_OWNED_DOMAIN_SET,
      );

      // Capture the pre-rotation row state.
      const before = await pool.query<{
        ciphertext: Buffer;
        wrapped_dek: string;
      }>(
        `SELECT ciphertext, wrapped_dek FROM event_redaction_map
         WHERE aice_id = $1 AND event_key = $2::numeric`,
        [AICE_ID, EVENT_KEY],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].wrapped_dek).toBe("vault:v1:map");
      const preEntities = JSON.parse(
        before.rows[0].ciphertext.toString("utf8"),
      ) as Record<string, { kind: string; value: string }>;
      const preValues = Object.values(preEntities)
        .map((e) => e.value)
        .sort();
      expect(preValues).toEqual(["10.0.0.42", "alice@example.com"]);

      // 2. Run `rotateAllKeks` with mocked Transit ops and the test
      //    pool wired in as the per-customer DB connection.
      //
      //    - rotateKey: no-op (Transit isn't reachable in this test)
      //    - rewrapDek: marker substitution so we can verify rewrap fired
      //    - authPool: serves one customer row and an empty staging list
      //    - connectCustomerDb: returns the existing test pool's query fn
      const rewrapDek = vi
        .fn()
        .mockImplementation((_c, _k, wrapped: string) =>
          Promise.resolve(wrapped.replace("v1", "v2")),
        );
      const authPool = {
        query: vi.fn((sql: string) => {
          if (/FROM customers/i.test(sql)) {
            return Promise.resolve({
              rows: [{ id: CUSTOMER_ID, wrapped_dek: null }],
            } as Partial<QueryResult>);
          }
          if (/FROM staged_event_payloads/i.test(sql)) {
            return Promise.resolve({ rows: [] } as Partial<QueryResult>);
          }
          return Promise.resolve({ rows: [] } as Partial<QueryResult>);
        }),
      } as unknown as Pool;

      const result = await rotateAllKeks(authPool, {
        transitConfig: { addr: "http://stub", token: "stub" },
        ownerTemplateUrl: "postgres://unused",
        rotateKey: vi.fn().mockResolvedValue(undefined),
        rewrapDek,
        connectCustomerDb: async () => ({
          query: pool.query.bind(pool) as Pool["query"],
          end: async () => {},
        }),
        clearCache: vi.fn(),
      });

      expect(result.customersErrored).toBe(0);
      expect(result.eventDeksRewrapped).toBeGreaterThanOrEqual(1);
      expect(rewrapDek).toHaveBeenCalled();

      // 3. Post-rotation row: wrapped_dek mutated, ciphertext untouched,
      //    decrypted entity map byte-identical to the pre-rotation map.
      const after = await pool.query<{
        ciphertext: Buffer;
        wrapped_dek: string;
      }>(
        `SELECT ciphertext, wrapped_dek FROM event_redaction_map
         WHERE aice_id = $1 AND event_key = $2::numeric`,
        [AICE_ID, EVENT_KEY],
      );
      expect(after.rows[0].wrapped_dek).toBe("vault:v2:map");
      const postEntities = JSON.parse(
        after.rows[0].ciphertext.toString("utf8"),
      ) as Record<string, { kind: string; value: string }>;
      expect(postEntities).toEqual(preEntities);
    });
  },
);
