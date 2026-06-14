// RFC 0003 self-fetch scheduler (3b, #570) — worker unit tests.
//
// Drives `runSelfFetchTickOnce` with a stubbed engine (`fetchAndImport`) and a
// stubbed schedule/state — NEVER live network. Covers:
//   - no-op when the schedule is disabled,
//   - no-op when the mode is not `self-fetch`,
//   - enabled + self-fetch fetches only DUE sources (never-fetched → due; a
//     within-cadence source is skipped),
//   - `intervalMs > floor` widens the effective cadence (a source fresh past
//     its floor but inside the interval is skipped),
//   - `intervalMs < floor` is clamped up to the floor,
//   - non-fetchable sources (`spamhaus/edrop`) are never fetched,
//   - install is idempotent and `uninstall` clears the timer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  installSelfFetchWorker,
  runSelfFetchTickOnce,
  uninstallSelfFetchWorker,
} from "../self-fetch-worker";

const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Catalog fetchable sources: feodo/urlhaus/urlhaus-payloads (5 min floor),
// spamhaus/drop and the four botvrij/* lists (1 h floor). spamhaus/edrop is
// NOT fetchable.
const FEODO = "abuse.ch/feodo";
const URLHAUS = "abuse.ch/urlhaus";
const URLHAUS_PAYLOADS = "abuse.ch/urlhaus-payloads";
const DROP = "spamhaus/drop";
const EDROP = "spamhaus/edrop";
const BOTVRIJ_IP = "botvrij/ip";
const BOTVRIJ_DOMAIN = "botvrij/domain";
const BOTVRIJ_URL = "botvrij/url";
const BOTVRIJ_HASH = "botvrij/hash";

const FETCHABLE = [
  FEODO,
  URLHAUS,
  URLHAUS_PAYLOADS,
  DROP,
  BOTVRIJ_IP,
  BOTVRIJ_DOMAIN,
  BOTVRIJ_URL,
  BOTVRIJ_HASH,
];

const NOW = new Date("2026-06-13T12:00:00.000Z");

/** A `feed_fetch_state` map keyed by source — controls the per-source clock. */
type StateMap = Record<string, { lastFetchedAt: string | null } | undefined>;

function makeDeps(opts: {
  enabled: boolean;
  intervalMs?: number;
  modeActive?: boolean;
  states?: StateMap;
  fetched: string[];
}) {
  const feedPoolStub = {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      // `readFeedFetchState` selects from feed_fetch_state by source id.
      const sourceId = params?.[0] as string;
      const state = opts.states?.[sourceId];
      if (!state) return { rows: [] };
      return {
        rows: [
          {
            source_policy_id: sourceId,
            last_fetched_at: state.lastFetchedAt
              ? new Date(state.lastFetchedAt)
              : null,
            last_attempt_at: null,
            etag: null,
            last_modified: null,
            last_status: null,
            last_error: null,
            last_row_count: null,
          },
        ],
      };
    }),
  };
  return {
    authPool: {} as never,
    feedPool: feedPoolStub as never,
    modeActive: () => opts.modeActive ?? true,
    readSchedule: async () => ({
      enabled: opts.enabled,
      intervalMs: opts.intervalMs,
    }),
    now: () => NOW,
    source: {
      fetchAndImport: vi.fn(async (id: string) => {
        opts.fetched.push(id);
        return { status: "imported" as const, rowCount: 1 };
      }),
    },
  };
}

describe("runSelfFetchTickOnce", () => {
  it("no-ops when the schedule is disabled", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({ enabled: false, fetched });
    await runSelfFetchTickOnce(deps);
    expect(fetched).toEqual([]);
    expect(deps.source.fetchAndImport).not.toHaveBeenCalled();
  });

  it("no-ops when the mode is not self-fetch", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({ enabled: true, modeActive: false, fetched });
    await runSelfFetchTickOnce(deps);
    expect(fetched).toEqual([]);
  });

  it("fetches every fetchable source when none was ever fetched", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({ enabled: true, fetched });
    await runSelfFetchTickOnce(deps);
    expect(fetched.sort()).toEqual([...FETCHABLE].sort());
  });

  it("never fetches a non-fetchable source (edrop)", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({ enabled: true, fetched });
    await runSelfFetchTickOnce(deps);
    expect(fetched).not.toContain(EDROP);
  });

  it("skips a source still within its effective cadence", async () => {
    const fetched: string[] = [];
    // Feodo fetched 2 min ago (< 5 min floor) → skipped; others never
    // fetched → due.
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString();
    const deps = makeDeps({
      enabled: true,
      states: { [FEODO]: { lastFetchedAt: twoMinAgo } },
      fetched,
    });
    await runSelfFetchTickOnce(deps);
    expect(fetched).not.toContain(FEODO);
    expect(fetched).toContain(URLHAUS);
  });

  it("fetches a source whose floor has elapsed", async () => {
    const fetched: string[] = [];
    const sixMinAgo = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    const deps = makeDeps({
      enabled: true,
      states: { [FEODO]: { lastFetchedAt: sixMinAgo } },
      fetched,
    });
    await runSelfFetchTickOnce(deps);
    expect(fetched).toContain(FEODO);
  });

  it("widens the effective cadence when intervalMs > floor", async () => {
    const fetched: string[] = [];
    // intervalMs = 30 min > 5 min floor. Feodo fetched 10 min ago: past the
    // floor but inside the 30-min interval → skipped.
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    const deps = makeDeps({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      states: { [FEODO]: { lastFetchedAt: tenMinAgo } },
      fetched,
    });
    await runSelfFetchTickOnce(deps);
    expect(fetched).not.toContain(FEODO);
  });

  it("clamps intervalMs up to the floor when intervalMs < floor", async () => {
    const fetched: string[] = [];
    // intervalMs = 1 min < 5 min floor. Feodo fetched 2 min ago: a naive
    // 1-min cadence would fetch, but the floor clamp (5 min) skips it.
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString();
    const deps = makeDeps({
      enabled: true,
      intervalMs: 60 * 1000,
      states: { [FEODO]: { lastFetchedAt: twoMinAgo } },
      fetched,
    });
    await runSelfFetchTickOnce(deps);
    expect(fetched).not.toContain(FEODO);
  });

  it("respects the 1 h floor for spamhaus/drop", async () => {
    const fetched: string[] = [];
    const thirtyMinAgo = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    const deps = makeDeps({
      enabled: true,
      states: { [DROP]: { lastFetchedAt: thirtyMinAgo } },
      fetched,
    });
    await runSelfFetchTickOnce(deps);
    // 30 min < 1 h floor → skipped.
    expect(fetched).not.toContain(DROP);
    // Sanity: a within-floor feodo would also have a distinct floor.
    expect(ONE_HOUR).toBeGreaterThan(FIVE_MIN);
  });

  it("isolates a single source failure", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({ enabled: true, fetched });
    deps.source.fetchAndImport = vi.fn(async (id: string) => {
      if (id === FEODO) throw new Error("boom");
      fetched.push(id);
      return { status: "imported" as const, rowCount: 1 };
    });
    await expect(runSelfFetchTickOnce(deps)).resolves.toBeUndefined();
    // The other sources still fetched despite feodo throwing.
    expect(fetched).toContain(URLHAUS);
  });
});

describe("install/uninstall", () => {
  afterEach(() => uninstallSelfFetchWorker());

  beforeEach(() => {
    process.env.TI_FEED_MODE = "fixture"; // tick no-ops; we only test the timer
  });

  it("install is idempotent and uninstall clears the timer", () => {
    const spy = vi.spyOn(global, "setInterval");
    installSelfFetchWorker();
    installSelfFetchWorker();
    expect(spy).toHaveBeenCalledTimes(1);
    uninstallSelfFetchWorker();
    // After uninstall, install schedules a fresh timer.
    installSelfFetchWorker();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
