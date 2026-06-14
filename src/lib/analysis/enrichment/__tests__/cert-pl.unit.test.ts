// RFC 0003 fan-out (#607) — CERT Polska Warning List source descriptor + fixture.
//
// Verifies the self-registered descriptor (active phishing domains), that the
// pinned synthetic fixture parses to its expected normalized rows via the shared
// `generic-list` parser (no bespoke parser), and a hit/miss against the list.
//
// Ships fixture-only (licence gate, RFC 0003 OQ9): the live `fetch` block is
// deliberately omitted pending the grant re-confirm, so the descriptor carries
// no `fetch` and `selfFetchUnavailable` is left unset (renders "Fixture only").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseFeedContent } from "../feed-import";
import "../sources";
import { getTiSourceDescriptor } from "../sources/registry";

const FEEDS_DIR = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
);
const fixture = (name: string): string =>
  readFileSync(join(FEEDS_DIR, name), "utf8");

describe("CERT Polska Warning List descriptor (#607)", () => {
  it("registers cert-pl/warninglist with the expected positive shape", () => {
    const d = getTiSourceDescriptor("cert-pl/warninglist");
    expect(d).toBeDefined();
    expect(d?.label).toBe("CERT Polska Warning List");
    expect(d?.entityType).toBe("DOMAIN");
    expect(d?.entityTypes).toEqual(["DOMAIN"]);
    expect(d?.parse).toBe("generic-list");
    expect(d?.parseConfig).toEqual({ kind: "generic-list" });
    expect(d?.hitType).toBe("deterministic_ioc");
    expect(d?.classification).toBe("phishing");
    expect(d?.deterministicCoverage).toBe(true);
    expect(d?.floorEligible).toBe(false);
    expect(d?.fixtureFile).toBe("cert-pl-warninglist.txt");
    // Positive known-bad feed, NOT the negative warninglist class (#599).
    expect(d?.polarity).toBeUndefined();
    // Fixture-only branch (licence gate): no live fetch, no "merged" flag.
    expect(d?.fetch).toBeUndefined();
    expect(d?.selfFetchUnavailable).toBeUndefined();
  });
});

describe("CERT Polska fixture parses to expected rows (#607)", () => {
  it("parses the domain list", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "DOMAIN",
        fixture("cert-pl-warninglist.txt"),
      ),
    ).toEqual([
      { matchValue: "platnosc-oszustwo.example" },
      { matchValue: "bank-logowanie.example" },
      { matchValue: "paczka-doplata.example" },
    ]);
  });
});

describe("CERT Polska hit/miss (#607)", () => {
  it("hits a listed domain and misses an unlisted one", () => {
    const set = new Set(
      parseFeedContent(
        "generic-list",
        "DOMAIN",
        fixture("cert-pl-warninglist.txt"),
      ).map((r) => r.matchValue),
    );
    expect(set.has("platnosc-oszustwo.example")).toBe(true);
    expect(set.has("good.example")).toBe(false);
  });
});
