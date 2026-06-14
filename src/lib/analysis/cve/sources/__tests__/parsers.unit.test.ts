// RFC 0005 (#611) — per-source CVE parser unit tests against pinned fixtures.
//
// Each core source parses its committed offline fixture into snapshot rows with
// the correct facts; no test queries a live CVE service. Covers the NVD
// CVSS-missing fallback (`cvssScore: null`, never an error).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEpss } from "../epss";
import { parseKev } from "../kev";
import { parseNvd } from "../nvd";

const FIXTURES = join(
  process.cwd(),
  "src/lib/analysis/cve/sources/__fixtures__",
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

describe("parseNvd", () => {
  const result = parseNvd(fixture("nvd.json"));
  const byCve = new Map(result.rows.map((r) => [r.cve, r]));

  it("surfaces totalResults for paging", () => {
    expect(result.totalResults).toBe(5);
    expect(result.rows).toHaveLength(5);
  });

  it("extracts CVSS base score (v3.1), vector, CWE, description, publish date", () => {
    const row = byCve.get("CVE-2024-3400");
    expect(row?.cvssScore).toBe(10.0);
    expect(row?.cvssVector).toBe(
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
    );
    // NVD-CWE-noinfo placeholder is dropped; only the real CWE remains.
    expect(row?.cwe).toEqual(["CWE-77"]);
    expect(row?.description).toMatch(/GlobalProtect/);
    // UTC-without-Z normalized to an instant.
    expect(row?.publishedAt).toBe("2024-04-12T08:15:06.230Z");
  });

  it("falls back to cvss: null for a very-recent CVE with no metrics", () => {
    const row = byCve.get("CVE-2026-0001");
    expect(row).toBeDefined();
    expect(row?.cvssScore).toBeNull();
    expect(row?.cvssVector).toBeNull();
    expect(row?.cwe).toBeNull();
    expect(row?.description).toMatch(/not yet been scored/);
  });

  it("reads a v3.0 metric and dedupes CWE ids", () => {
    const row = byCve.get("CVE-2024-23897");
    expect(row?.cvssScore).toBe(9.8);
    expect(row?.cwe).toEqual(["CWE-27"]);
  });

  it("reads a CVSS v4.0-only metric (not just v3.x/v2)", () => {
    const row = byCve.get("CVE-2025-40000");
    expect(row?.cvssScore).toBe(8.7);
    expect(row?.cvssVector).toBe(
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N",
    );
  });

  it("prefers the Primary metric over a Secondary one listed first", () => {
    const row = byCve.get("CVE-2025-50000");
    expect(row?.cvssScore).toBe(7.5);
    expect(row?.cvssVector).toBe(
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    );
  });
});

describe("parseKev", () => {
  const rows = parseKev(fixture("kev.json")).rows;
  const byCve = new Map(rows.map((r) => [r.cve, r]));

  it("marks every entry known-exploited + in-the-wild with its dateAdded", () => {
    expect(rows).toHaveLength(2);
    const row = byCve.get("CVE-2024-3400");
    expect(row?.kevKnownExploited).toBe(true);
    expect(row?.inTheWild).toBe(true);
    expect(row?.kevDateAdded).toBe("2024-04-12");
    expect(row?.description).toMatch(/actively exploited/);
  });

  it("carries no CVSS/EPSS facts (source-local columns only)", () => {
    const row = byCve.get("CVE-2023-1389");
    expect(row?.cvssScore ?? null).toBeNull();
    expect(row?.epssScore ?? null).toBeNull();
    expect(row?.publishedAt ?? null).toBeNull();
  });
});

describe("parseEpss", () => {
  const rows = parseEpss(fixture("epss.csv")).rows;
  const byCve = new Map(rows.map((r) => [r.cve, r]));

  it("skips the comment + header and reads score + percentile", () => {
    expect(rows).toHaveLength(3);
    const row = byCve.get("CVE-2024-3400");
    expect(row?.epssScore).toBeCloseTo(0.94521, 5);
    expect(row?.epssPercentile).toBeCloseTo(0.99987, 5);
  });

  it("does not surface totalResults (single-shot source)", () => {
    expect(parseEpss(fixture("epss.csv")).totalResults).toBeUndefined();
  });

  it("ignores blank/comment lines and malformed rows", () => {
    const rows2 = parseEpss(
      "#header-comment\ncve,epss,percentile\n\nCVE-2024-0002,notanum,0.5\nCVE-2024-0003,0.3,0.7\n",
    ).rows;
    expect(rows2.map((r) => r.cve)).toEqual(["CVE-2024-0003"]);
  });
});
