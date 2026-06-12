// RFC 0003 Tier-1 feed-refresh (#564) — `FeedSource` seam unit tests
// (pure / disk-only, no DB). The DB import path is covered by the worker
// db tests; here we pin the mode resolver's fail-fast contract and the
// `FixtureFeedSource` raw-payload shape (it yields bytes + provenance and
// does NOT parse).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEFAULT_TI_FEED_MODE,
  resolveTiFeedMode,
  SUPPORTED_TI_FEED_MODES,
  TI_FEED_MODES,
} from "../feed-source";

describe("resolveTiFeedMode", () => {
  it("defaults to fixture when unset or empty", () => {
    expect(resolveTiFeedMode(undefined)).toBe("fixture");
    expect(resolveTiFeedMode("")).toBe("fixture");
    expect(DEFAULT_TI_FEED_MODE).toBe("fixture");
  });

  it("accepts the supported `fixture` mode", () => {
    expect(resolveTiFeedMode("fixture")).toBe("fixture");
  });

  it("throws on an unknown value (typo / bad config)", () => {
    expect(() => resolveTiFeedMode("bogus")).toThrow(/Unknown TI_FEED_MODE/);
  });

  it("throws on a defined-but-not-yet-implemented mode (parts 2-4)", () => {
    // These are reserved in the value space but unimplemented in part 1;
    // they must fail fast rather than silently importing nothing.
    for (const mode of TI_FEED_MODES) {
      if (SUPPORTED_TI_FEED_MODES.includes(mode)) {
        continue;
      }
      expect(() => resolveTiFeedMode(mode)).toThrow(/not yet implemented/);
    }
  });

  it("reserves the full series value space in order", () => {
    expect(TI_FEED_MODES).toEqual([
      "fixture",
      "manual-upload",
      "self-fetch",
      "managed",
    ]);
    expect(SUPPORTED_TI_FEED_MODES).toEqual(["fixture"]);
  });
});

describe("FixtureFeedSource", () => {
  it("yields raw, unparsed payloads + provenance for each fixture feed", async () => {
    // fixture-feeds.ts imports "server-only" (mocked above); import it
    // here so the mock is in place before the module loads.
    const { FixtureFeedSource, FIXTURE_FEEDS } = await import(
      "../fixture-feeds"
    );
    const source = new FixtureFeedSource({
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
      sourceVersion: "v-test",
    });
    expect(source.mode).toBe("fixture");

    const payloads = await source.loadPayloads();
    // One payload per fixture spec, tagged for the common downstream.
    expect(payloads).toHaveLength(FIXTURE_FEEDS.length);

    for (const payload of payloads) {
      const spec = FIXTURE_FEEDS.find(
        (s) => s.sourcePolicyId === payload.sourcePolicyId,
      );
      expect(spec).toBeDefined();
      // The payload carries parse metadata but NOT parsed rows — `content`
      // is the raw file bytes verbatim.
      expect(payload.parse).toBe(spec?.parse);
      expect(payload.entityType).toBe(spec?.entityType);
      expect(payload.hitType).toBe(spec?.hitType);
      expect(typeof payload.content).toBe("string");
      expect(payload.content.length).toBeGreaterThan(0);
      // Provenance stamps mode + freshness for audit / stale-coverage.
      expect(payload.provenance.mode).toBe("fixture");
      expect(payload.provenance.sourceUpdatedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      expect(payload.provenance.sourceVersion).toBe("v-test");
      expect(payload.provenance.origin).toContain(spec?.file);
    }
  });
});
