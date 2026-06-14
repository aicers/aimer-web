// Unit tests for the server-side IOC evidence loader (#591):
//   - the verdict from the enrichment-state row (zero-evidence-complete vs
//     false-unknown vs not-run/failed);
//   - evidence resolution: class flags, source-label resolution + unknown-
//     policy fallback, and redaction-consistent indicator display (raw
//     external shown raw, customer-asset de-mapped strictly within its own
//     scope and NEVER cross-scope, token-only degrade when the map is absent);
//   - the story canonical-version join feeding the evidence query.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedactionMap } from "@/lib/redaction";

vi.mock("server-only", () => ({}));

// decryptRedactionMap is keyed by ciphertext bytes in these tests: a known
// ciphertext resolves to its scope's map; the sentinel `bad` ciphertext throws
// to exercise the token-only degrade path.
const MAPS: Record<string, RedactionMap> = {
  scopeA: { "<<REDACTED_IP_001>>": { kind: "ip", value: "10.0.0.5" } },
  scopeB: { "<<REDACTED_IP_001>>": { kind: "ip", value: "192.168.1.9" } },
};
const mockDecrypt = vi.fn(async (_cid: string, ciphertext: Buffer) => {
  const key = ciphertext.toString();
  if (key === "bad") throw new Error("decrypt failed");
  const map = MAPS[key];
  if (!map) throw new Error(`no map for ${key}`);
  return map;
});
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: (...args: unknown[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: test shim
    mockDecrypt(...(args as [any, any])),
}));

// Source-label resolution: a known policy resolves to its label; an unknown
// (retired) policy resolves to undefined so the loader falls back to the id.
vi.mock("../enrichment/feed-catalog", () => ({
  getTier1FeedSource: (id: string) =>
    id === "abuse.ch/feodo" ? { label: "abuse.ch Feodo Tracker" } : undefined,
}));

const CUSTOMER_ID = "c-1";

// A simple SQL-routed fake pool. Each test sets the rows returned per table.
let canonicalRows: Array<Record<string, unknown>>;
let storyEvidenceRows: Array<Record<string, unknown>>;
let eventStateRows: Array<Record<string, unknown>>;
let eventEvidenceRows: Array<Record<string, unknown>>;
let mapRows: Array<Record<string, unknown>>;

const pool = {
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM story s")) return { rows: canonicalRows };
    if (sql.includes("FROM story_ioc_evidence")) {
      return { rows: storyEvidenceRows };
    }
    if (sql.includes("FROM event_enrichment_state")) {
      return { rows: eventStateRows };
    }
    if (sql.includes("FROM event_ioc_evidence")) {
      return { rows: eventEvidenceRows };
    }
    if (sql.includes("FROM event_redaction_map")) return { rows: mapRows };
    return { rows: [] };
  }),
};

function evidenceRow(extras: Record<string, unknown> = {}) {
  return {
    redaction_token: "203.0.113.7",
    source_aice_id: "aice-a",
    scope_event_key: "10",
    source_policy_id: "abuse.ch/feodo",
    source_version: "2026-06-01",
    feed_hash: "deadbeef",
    hit_type: "deterministic_ioc",
    floor_eligible: true,
    coverage_status: "complete",
    checked_at: new Date("2026-06-10T00:00:00Z"),
    ...extras,
  };
}

async function loadStory() {
  const mod = await import("../ioc-evidence-loader");
  return mod.loadStoryIocEnrichment(pool, CUSTOMER_ID, "12345");
}

async function loadEvent(pageMap: RedactionMap = {}) {
  const mod = await import("../ioc-evidence-loader");
  return mod.loadEventIocEnrichment(pool, "aice-a", "10", pageMap);
}

beforeEach(() => {
  vi.resetModules();
  pool.query.mockClear();
  mockDecrypt.mockClear();
  canonicalRows = [
    {
      story_version: "v1",
      status: "complete",
      known_ioc_hit: false,
      coverage_status: "complete",
    },
  ];
  storyEvidenceRows = [];
  eventStateRows = [];
  eventEvidenceRows = [];
  mapRows = [];
});

describe("loadStoryIocEnrichment — verdict", () => {
  it("returns a clean-complete verdict with zero evidence", async () => {
    const out = await loadStory();
    expect(out.verdict).toEqual({
      knownIocHit: false,
      coverageStatus: "complete",
    });
    expect(out.evidence).toEqual([]);
  });

  it("returns a false-unknown verdict (degraded coverage)", async () => {
    canonicalRows = [
      {
        story_version: "v1",
        status: "complete",
        known_ioc_hit: false,
        coverage_status: "unknown",
      },
    ];
    const out = await loadStory();
    expect(out.verdict).toEqual({
      knownIocHit: false,
      coverageStatus: "unknown",
    });
  });

  it("returns not-run (null) when the LEFT JOIN found no state row", async () => {
    canonicalRows = [
      {
        story_version: "v1",
        status: null,
        known_ioc_hit: null,
        coverage_status: null,
      },
    ];
    const out = await loadStory();
    expect(out.verdict).toBeNull();
  });

  it("returns not-run (null) for a failed run, never a clean verdict", async () => {
    canonicalRows = [
      {
        story_version: "v1",
        status: "failed",
        known_ioc_hit: false,
        coverage_status: "unknown",
      },
    ];
    const out = await loadStory();
    expect(out.verdict).toBeNull();
  });

  it("returns not-run with no evidence when the story row is absent", async () => {
    canonicalRows = [];
    const out = await loadStory();
    expect(out).toEqual({ verdict: null, evidence: [] });
    // No evidence query runs when there is no canonical version.
    expect(
      pool.query.mock.calls.some((c) =>
        String(c[0]).includes("FROM story_ioc_evidence"),
      ),
    ).toBe(false);
  });

  it("joins evidence on the resolved canonical story_version", async () => {
    canonicalRows = [
      {
        story_version: "v7",
        status: "complete",
        known_ioc_hit: true,
        coverage_status: "complete",
      },
    ];
    await loadStory();
    const evCall = pool.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM story_ioc_evidence"),
    );
    expect(evCall?.[1]).toEqual(["12345", "v7"]);
  });
});

describe("loadStoryIocEnrichment — evidence resolution", () => {
  it("derives the three classes and resolves the source label", async () => {
    storyEvidenceRows = [
      evidenceRow({ hit_type: "deterministic_ioc", floor_eligible: true }),
      evidenceRow({ hit_type: "deterministic_ioc", floor_eligible: false }),
      evidenceRow({ hit_type: "soft_reputation", floor_eligible: false }),
    ];
    const out = await loadStory();
    expect(out.evidence.map((e) => e.evidenceClass)).toEqual([
      "floor_supporting",
      "floor_ineligible_deterministic",
      "promoted_soft",
    ]);
    expect(out.evidence[0].sourceLabel).toBe("abuse.ch Feodo Tracker");
    expect(out.evidence[0].sourceVersion).toBe("2026-06-01");
    expect(out.evidence[0].feedHash).toBe("deadbeef");
  });

  it("falls back to the id for an unknown (retired) source policy", async () => {
    storyEvidenceRows = [evidenceRow({ source_policy_id: "retired/source" })];
    const out = await loadStory();
    expect(out.evidence[0].sourceLabel).toBe("retired/source");
    expect(out.evidence[0].sourcePolicyId).toBe("retired/source");
  });

  it("shows a raw external indicator directly (no de-map attempted)", async () => {
    storyEvidenceRows = [evidenceRow({ redaction_token: "203.0.113.7" })];
    const out = await loadStory();
    expect(out.evidence[0].indicator).toBe("203.0.113.7");
    expect(out.evidence[0].indicatorRedacted).toBe(false);
    // No redaction-map decrypt for a raw external indicator.
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("de-maps a customer-asset token strictly within its own scope (never cross-scope)", async () => {
    storyEvidenceRows = [
      evidenceRow({
        redaction_token: "<<REDACTED_IP_001>>",
        source_aice_id: "aice-a",
        scope_event_key: "10",
      }),
      evidenceRow({
        redaction_token: "<<REDACTED_IP_001>>",
        source_aice_id: "aice-b",
        scope_event_key: "20",
      }),
    ];
    mapRows = [
      {
        aice_id: "aice-a",
        event_key: "10",
        ciphertext: Buffer.from("scopeA"),
        wrapped_dek: "dekA",
      },
      {
        aice_id: "aice-b",
        event_key: "20",
        ciphertext: Buffer.from("scopeB"),
        wrapped_dek: "dekB",
      },
    ];
    const out = await loadStory();
    // The same token resolves to DIFFERENT values per scope — never cross-mapped.
    expect(out.evidence[0].indicator).toBe("10.0.0.5");
    expect(out.evidence[0].indicatorRedacted).toBe(false);
    expect(out.evidence[1].indicator).toBe("192.168.1.9");
    expect(out.evidence[1].indicatorRedacted).toBe(false);
  });

  it("degrades to token-only when the scope map is missing or undecryptable", async () => {
    storyEvidenceRows = [
      evidenceRow({
        redaction_token: "<<REDACTED_IP_001>>",
        source_aice_id: "aice-a",
        scope_event_key: "10",
      }),
    ];
    // A map row whose ciphertext fails to decrypt.
    mapRows = [
      {
        aice_id: "aice-a",
        event_key: "10",
        ciphertext: Buffer.from("bad"),
        wrapped_dek: "dek",
      },
    ];
    const out = await loadStory();
    expect(out.evidence[0].indicator).toBe("<<REDACTED_IP_001>>");
    expect(out.evidence[0].indicatorRedacted).toBe(true);
  });
});

describe("loadEventIocEnrichment", () => {
  it("returns not-run for a manual-only event with no state row", async () => {
    eventStateRows = [];
    const out = await loadEvent();
    expect(out.verdict).toBeNull();
    expect(out.evidence).toEqual([]);
  });

  it("returns the verdict from a completed event-enrichment-state row", async () => {
    eventStateRows = [
      { status: "complete", known_ioc_hit: true, coverage_status: "complete" },
    ];
    const out = await loadEvent();
    expect(out.verdict).toEqual({
      knownIocHit: true,
      coverageStatus: "complete",
    });
  });

  it("de-maps an event indicator via the page map (no extra decrypt)", async () => {
    eventStateRows = [
      { status: "complete", known_ioc_hit: true, coverage_status: "complete" },
    ];
    eventEvidenceRows = [
      evidenceRow({
        redaction_token: "<<REDACTED_IP_001>>",
        source_aice_id: "aice-a",
        scope_event_key: "10",
      }),
    ];
    const out = await loadEvent({
      "<<REDACTED_IP_001>>": { kind: "ip", value: "172.16.0.4" },
    });
    expect(out.evidence[0].indicator).toBe("172.16.0.4");
    expect(out.evidence[0].indicatorRedacted).toBe(false);
    // The event path reuses the page's already-decrypted map.
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});
