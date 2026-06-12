// RFC 0003 self-fetch (3a, #568) — self-fetch engine DB tests.
//
// Exercises `SelfFetchFeedSource.fetchAndImport` and `PgFeedStore.probe`
// against a real feed DB, with the HTTP transport mocked (200 / 304 /
// failure) — NEVER live network. Covers:
//   - 200 replaces the snapshot via the replace-only downstream + records ok,
//   - 304 leaves the snapshot untouched but bumps `last_fetched_at`,
//   - failure→stale: snapshot + `last_fetched_at` untouched, error recorded,
//   - the cadence-floor guard (too-soon skip, no fetch),
//   - single-flight (a held advisory lock makes a concurrent fetch skip),
//   - a successful 0-row fetch reads as present,
//   - the URLhaus Auth-Key reaches the request URL path,
//   - `probe()` semantics for self-fetch (fetch-state is the authority).

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
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";
import {
  FEED_FETCH_LOCK_NS,
  type FetchResponseLike,
  type FetchTransport,
  feedFetchLockKey,
  readFeedFetchState,
  SelfFetchFeedSource,
} from "../feed-fetch";
import { PgFeedStore } from "../feed-store";

const FEED_MIGRATIONS_DIR = join(process.cwd(), "migrations", "feed");
const FEED_LOCK_ID = 5681;

const T0 = new Date("2026-06-12T00:00:00.000Z");
const T_PAST_FLOOR = new Date("2026-06-12T00:06:00.000Z"); // +6 min > 5 min floor
const T_WITHIN_FLOOR = new Date("2026-06-12T00:02:00.000Z"); // +2 min < 5 min

function resp(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/** A transport serving queued responses; records the URLs it was called with. */
function queuedTransport(queue: (FetchResponseLike | Error)[]): {
  transport: FetchTransport;
  urls: string[];
} {
  const urls: string[] = [];
  const transport: FetchTransport = async (url) => {
    urls.push(url);
    const next = queue.shift();
    if (next === undefined) throw new Error("no queued response");
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, urls };
}

async function snapshotCount(
  pool: Pool,
  sourcePolicyId: string,
): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM ioc_feed_snapshot WHERE source_policy_id = $1`,
    [sourcePolicyId],
  );
  return Number(rows[0].cnt);
}

describe.skipIf(!hasPostgres)("self-fetch engine (DB)", () => {
  let feedDbName: string;
  let feedPool: Pool;

  beforeEach(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    const feed = await createTestDatabase("ti_feed_fetch", "feed");
    feedDbName = feed.dbName;
    feedPool = feed.pool;
    await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);
  });

  afterAll(async () => {
    if (feedPool) {
      await dropTestDatabase(feedDbName, feedPool, "feed");
    }
    await closeAdminPool();
  });

  function engine(
    queue: (FetchResponseLike | Error)[],
    now: Date,
  ): { source: SelfFetchFeedSource; urls: string[] } {
    const { transport, urls } = queuedTransport(queue);
    const source = new SelfFetchFeedSource({
      feedPool,
      transport,
      now: () => now,
      resolveAuthKey: async () => "TEST-KEY",
    });
    return { source, urls };
  }

  it("200 imports rows and records ok state (etag + row count)", async () => {
    const { source } = engine(
      [resp(200, "45.66.230.5\n198.51.100.7\n", { etag: '"v1"' })],
      T0,
    );
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome).toEqual({ status: "imported", rowCount: 2 });
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(2);

    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state).toMatchObject({
      lastStatus: "ok",
      etag: '"v1"',
      lastRowCount: 2,
      lastFetchedAt: T0.toISOString(),
    });
  });

  it("304 leaves the snapshot untouched but bumps last_fetched_at", async () => {
    const seeded = engine([resp(200, "45.66.230.5\n", { etag: '"v1"' })], T0);
    await seeded.source.fetchAndImport("abuse.ch/feodo");

    const { source } = engine([resp(304, "")], T_PAST_FLOOR);
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome).toEqual({ status: "not-modified" });

    // Snapshot rows are untouched; only fetch-state moved.
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(1);
    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state).toMatchObject({
      lastStatus: "not-modified",
      etag: '"v1"', // prior validator preserved
      lastFetchedAt: T_PAST_FLOOR.toISOString(),
    });
  });

  it("failure→stale: snapshot + last_fetched_at untouched, error recorded", async () => {
    const seeded = engine([resp(200, "45.66.230.5\n", { etag: '"v1"' })], T0);
    await seeded.source.fetchAndImport("abuse.ch/feodo");

    const { source } = engine([new Error("connection reset")], T_PAST_FLOOR);
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome.status).toBe("error");

    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(1);
    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state).toMatchObject({
      lastStatus: "error",
      lastFetchedAt: T0.toISOString(), // NOT bumped — freshness decays
    });
    expect(state?.lastError).toContain("connection reset");
  });

  it("a 5xx response is a failure (not an import)", async () => {
    const { source } = engine([resp(503, "upstream down")], T0);
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome.status).toBe("error");
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(0);
    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state?.lastStatus).toBe("error");
    expect(state?.lastFetchedAt).toBeNull();
  });

  it("a 200 that parses to zero rows but has data is failure→stale", async () => {
    // Seed a good snapshot first.
    const seeded = engine([resp(200, "45.66.230.5\n", { etag: '"v1"' })], T0);
    await seeded.source.fetchAndImport("abuse.ch/feodo");

    // Upstream returns an HTML error page with a 200: data lines, zero rows.
    const { source } = engine(
      [resp(200, "<html><body>503 Service Unavailable</body></html>")],
      T_PAST_FLOOR,
    );
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome.status).toBe("error");

    // The good snapshot is preserved and the freshness clock is NOT bumped, so
    // the source decays to stale rather than reading fresh+empty.
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(1);
    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state).toMatchObject({
      lastStatus: "error",
      lastFetchedAt: T0.toISOString(),
    });
  });

  it("a comment-only 200 legitimately imports 0 rows (empty feed)", async () => {
    const { source } = engine([resp(200, "# no entries today\n")], T0);
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome).toEqual({ status: "imported", rowCount: 0 });
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(0);
  });

  it("enforces the cadence floor (too-soon skip, no fetch)", async () => {
    const seeded = engine([resp(200, "45.66.230.5\n")], T0);
    await seeded.source.fetchAndImport("abuse.ch/feodo");

    const { source, urls } = engine(
      [resp(200, "203.0.113.9\n")],
      T_WITHIN_FLOOR,
    );
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome).toEqual({
      status: "too-soon",
      nextAllowedAt: "2026-06-12T00:05:00.000Z",
    });
    // The transport was never called and the snapshot is unchanged.
    expect(urls).toHaveLength(0);
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(1);
  });

  it("single-flights: skips when the per-source lock is held", async () => {
    // Hold the advisory lock on a separate connection.
    const holder = await feedPool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock($1, $2)`, [
        FEED_FETCH_LOCK_NS,
        feedFetchLockKey("abuse.ch/feodo"),
      ]);

      const { source, urls } = engine([resp(200, "45.66.230.5\n")], T0);
      const outcome = await source.fetchAndImport("abuse.ch/feodo");
      expect(outcome).toEqual({ status: "locked" });
      expect(urls).toHaveLength(0);
      expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(0);
    } finally {
      await holder
        .query(`SELECT pg_advisory_unlock($1, $2)`, [
          FEED_FETCH_LOCK_NS,
          feedFetchLockKey("abuse.ch/feodo"),
        ])
        .catch(() => {});
      holder.release();
    }
  });

  it("a successful but empty (0-row) feed imports and reads as present", async () => {
    const { source } = engine([resp(200, "# nothing today\n")], T0);
    const outcome = await source.fetchAndImport("abuse.ch/feodo");
    expect(outcome).toEqual({ status: "imported", rowCount: 0 });
    expect(await snapshotCount(feedPool, "abuse.ch/feodo")).toBe(0);
    const state = await readFeedFetchState(feedPool, "abuse.ch/feodo");
    expect(state).toMatchObject({ lastStatus: "ok", lastRowCount: 0 });
  });

  it("sends the URLhaus Auth-Key in the request URL path", async () => {
    const { source, urls } = engine(
      [
        resp(
          200,
          '# id,dateadded,url\n"1","2026-01-01","http://evil.test/x"\n',
        ),
      ],
      T0,
    );
    const outcome = await source.fetchAndImport("abuse.ch/urlhaus");
    expect(outcome.status).toBe("imported");
    expect(urls[0]).toContain("/exports/TEST-KEY/");
  });

  it("concatenates multi-URL Spamhaus NDJSON (v4 + v6)", async () => {
    const { source, urls } = engine(
      [
        resp(200, '{"cidr":"1.2.3.0/24","sblid":"SBL1"}\n'),
        resp(200, '{"cidr":"2001:db8::/32","sblid":"SBL2"}\n'),
      ],
      T0,
    );
    const outcome = await source.fetchAndImport("spamhaus/drop");
    expect(outcome).toEqual({ status: "imported", rowCount: 2 });
    expect(urls).toHaveLength(2);
    const { rows } = await feedPool.query<{ cidr: string }>(
      `SELECT cidr::text AS cidr FROM ioc_feed_snapshot
        WHERE source_policy_id = 'spamhaus/drop' ORDER BY cidr`,
    );
    expect(rows.map((r) => r.cidr)).toEqual(["1.2.3.0/24", "2001:db8::/32"]);
  });

  it("rejects a source with no self-fetch config (EDROP, merged)", async () => {
    const { source } = engine([], T0);
    const outcome = await source.fetchAndImport("spamhaus/edrop");
    expect(outcome.status).toBe("error");
  });
});

describe.skipIf(!hasPostgres)(
  "PgFeedStore.probe (self-fetch authority)",
  () => {
    let feedDbName: string;
    let feedPool: Pool;
    let prevMode: string | undefined;

    // Capture the original mode ONCE before any test runs; capturing it in
    // `beforeEach` would read back the `self-fetch` value the first test set,
    // and the `afterAll` restore would then leave the worker polluted.
    beforeAll(() => {
      prevMode = process.env.TI_FEED_MODE;
      process.env.TI_FEED_MODE = "self-fetch";
    });

    beforeEach(async () => {
      if (feedPool) {
        await dropTestDatabase(feedDbName, feedPool, "feed");
      }
      const feed = await createTestDatabase("ti_feed_probe", "feed");
      feedDbName = feed.dbName;
      feedPool = feed.pool;
      await runMigrations(feedPool, FEED_MIGRATIONS_DIR, FEED_LOCK_ID);
    });

    afterAll(async () => {
      if (prevMode === undefined) delete process.env.TI_FEED_MODE;
      else process.env.TI_FEED_MODE = prevMode;
      if (feedPool) {
        await dropTestDatabase(feedDbName, feedPool, "feed");
      }
      await closeAdminPool();
    });

    function engine(
      queue: (FetchResponseLike | Error)[],
      now: Date,
    ): SelfFetchFeedSource {
      const { transport } = queuedTransport(queue);
      return new SelfFetchFeedSource({
        feedPool,
        transport,
        now: () => now,
        resolveAuthKey: async () => "TEST-KEY",
      });
    }

    it("a 0-row 200 reads as present, fresh at last_fetched_at", async () => {
      await engine([resp(200, "# empty\n")], T0).fetchAndImport(
        "abuse.ch/feodo",
      );
      const meta = await new PgFeedStore(feedPool).probe("abuse.ch/feodo");
      expect(meta.present).toBe(true);
      expect(meta.sourceUpdatedAt).toBe(T0.toISOString());
    });

    it("a 304 keeps the source present/fresh via last_fetched_at", async () => {
      await engine(
        [resp(200, "45.66.230.5\n", { etag: '"v1"' })],
        T0,
      ).fetchAndImport("abuse.ch/feodo");
      await engine([resp(304, "")], T_PAST_FLOOR).fetchAndImport(
        "abuse.ch/feodo",
      );
      const meta = await new PgFeedStore(feedPool).probe("abuse.ch/feodo");
      expect(meta.present).toBe(true);
      expect(meta.sourceUpdatedAt).toBe(T_PAST_FLOOR.toISOString());
    });

    it("a failure leaves freshness at the prior successful fetch", async () => {
      await engine([resp(200, "45.66.230.5\n")], T0).fetchAndImport(
        "abuse.ch/feodo",
      );
      await engine([new Error("timeout")], T_PAST_FLOOR).fetchAndImport(
        "abuse.ch/feodo",
      );
      const meta = await new PgFeedStore(feedPool).probe("abuse.ch/feodo");
      expect(meta.present).toBe(true);
      // Freshness did NOT advance to the failed attempt — it decays from T0.
      expect(meta.sourceUpdatedAt).toBe(T0.toISOString());
    });

    it("a source that has only ever failed reads as absent", async () => {
      await engine([new Error("dns")], T0).fetchAndImport("abuse.ch/feodo");
      const meta = await new PgFeedStore(feedPool).probe("abuse.ch/feodo");
      expect(meta.present).toBe(false);
    });

    it("a never-fetched source reads as absent", async () => {
      const meta = await new PgFeedStore(feedPool).probe("abuse.ch/urlhaus");
      expect(meta.present).toBe(false);
    });
  },
);
