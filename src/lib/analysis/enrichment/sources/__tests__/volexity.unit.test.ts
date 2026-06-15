// RFC 0003 F4 fan-out (#625) — Volexity vendor-repo source unit tests (pure /
// disk-only, no DB). Drives the merged vendor-repo engine (#603) over the
// committed `volexity-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist / value-column shape classification / context / refang
// behavior is exercised end-to-end:
//   - the CSV parses ONLY column 0 (`value`) via `csv-column`/`shapeColumn`,
//     shape-classifying each cell to DOMAIN/IP/URL/HASH (a `file` cell's packed
//     hashes split per hash; `hxxp://` rows refanged),
//   - a benign domain/URL in the `description`/`notes` column is NEVER ingested
//     (the comma-bug + sibling-column false positives of whole-line `free-text`
//     cannot fire),
//   - `attachments/` web-shell, `scripts/` tooling, and `.yar` rule files are
//     never fetched (allowlist skip), and both CSV placements (post-root
//     `iocs.csv` and nested `indicators/indicators.csv`) are discovered.

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectVendorRepoRows,
  FixtureVendorRepoProvider,
  type VendorRepoCollectInput,
} from "../../feed-vendor-repo";
import "../index";
import { getTiSourceDescriptor } from "../registry";

const FIXTURE_ROOT = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
  "volexity-fixture",
);

const BLOB_BASE =
  "https://github.com/volexity/threat-intel/blob/" +
  "5fd84467b3ecfddb0db2f2b9ae747d70c6d56492";

const IOCS_PATH = "2024/2024-06-14-operation-fixture/iocs.csv";
const INDICATORS_PATH =
  "2024/2024-06-15-second-fixture/indicators/indicators.csv";

const SHA256 =
  "1111111111111111111111111111111111111111111111111111111111111111";
const MD5 = "22222222222222222222222222222222";
const SHA1 = "3333333333333333333333333333333333333333";

function descriptor() {
  const d = getTiSourceDescriptor("volexity/threat-intel");
  if (!d) throw new Error("volexity/threat-intel descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("volexity descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("volexity/threat-intel descriptor", () => {
  it("registers a vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("Volexity (BSD-2-Clause)");
    expect(d.entityTypes).toEqual(["DOMAIN", "IP", "HASH", "URL"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    expect(d.classification).toBe("vendor_report");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("DOMAIN");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("volexity");
    expect(vr?.repo).toBe("threat-intel");
    expect(vr?.ref).toBe("5fd84467b3ecfddb0db2f2b9ae747d70c6d56492");
    expect(vr?.fixtureDir).toBe("volexity-fixture");
    expect(vr?.reportUrlTemplate).toBe(
      "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    );
    // A single allowlist rule reading ONLY the value column by shape.
    expect(vr?.files).toHaveLength(1);
    expect(vr?.files[0].parse).toBe("csv-column");
    expect(vr?.files[0].parseConfig).toEqual({
      kind: "csv-column",
      shapeColumn: { value: { index: 0 } },
      skipHeader: true,
      refang: true,
    });
    // No flat self-fetch config — a vendor repo is fetched as a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the volexity fixture tree", () => {
  it("parses ONLY the value column → shape-classified rows, splitting packed hashes", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );

    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    // iocs.csv — hostname / ipaddress / hxxp-url / packed-hash file row.
    expect(byValue.get("bad.volexity.test")?.entityType).toBe("DOMAIN");
    expect(byValue.get("185.220.101.50")?.entityType).toBe("IP");
    // `hxxp://` refanged to a real URL.
    expect(
      byValue.get("http://malware.volexity.test/payload")?.entityType,
    ).toBe("URL");
    // The single `file` cell's three packed hashes split into per-hash rows.
    expect(byValue.get(SHA256)?.entityType).toBe("HASH");
    expect(byValue.get(MD5)?.entityType).toBe("HASH");
    expect(byValue.get(SHA1)?.entityType).toBe("HASH");
    // indicators/indicators.csv (2018-style header drift) — recursion finds it.
    expect(byValue.get("phish.volexity.test")?.entityType).toBe("DOMAIN");
    expect(byValue.get("http://c2.volexity.test/gate")?.entityType).toBe("URL");
    // Exactly the eight value-column IOCs across the two CSV placements.
    expect(rows).toHaveLength(8);

    // Both CSV placements fetched; everything else allowlist-skipped.
    expect(fetched.sort()).toEqual([IOCS_PATH, INDICATORS_PATH].sort());
    expect(skipped).toContain(
      "2024/2024-06-14-operation-fixture/attachments/glasstoken_v1.aspx",
    );
    expect(skipped).toContain(
      "2024/2024-06-14-operation-fixture/detection.yar",
    );
    expect(skipped).toContain(
      "2024/2024-06-14-operation-fixture/scripts/extract.py",
    );
  });

  it("does NOT ingest a benign domain/URL from the description column", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    // These live ONLY in the `description`/`notes` column, which the value-
    // column shape parser never scans — so the false-positive guard holds.
    expect(values).not.toContain("benign-decoy.example.com");
    expect(values).not.toContain("decoy.example.org");
  });

  it("URL rows carry no interior-comma pollution (the comma-bug guard)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const urlRows = rows.filter((r) => r.entityType === "URL");
    // Both URLs parse cleanly to the value only — no trailing `,url,...` CSV
    // fields absorbed (which whole-line `free-text` would have done).
    expect(urlRows.map((r) => r.matchValue).sort()).toEqual([
      "http://c2.volexity.test/gate",
      "http://malware.volexity.test/payload",
    ]);
    for (const row of urlRows) {
      expect(row.matchValue).not.toContain(",");
    }
  });

  it("never reads the attachments / scripts / .yar (allowlist skip — bytes never fetched)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain(
      "2024/2024-06-14-operation-fixture/attachments/glasstoken_v1.aspx",
    );
    expect(provider.readPaths).not.toContain(
      "2024/2024-06-14-operation-fixture/detection.yar",
    );
    expect(provider.readPaths).not.toContain(
      "2024/2024-06-14-operation-fixture/scripts/extract.py",
    );
  });

  it("does not leak a sentinel token from a skipped attachment/script/rule file", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(values).not.toContain("should-never-be-fetched");
  });

  it("threads per-file blob reportUrl + folder campaign onto each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const domainRow = rows.find((r) => r.matchValue === "bad.volexity.test");
    expect(domainRow?.context).toEqual({
      campaign: "2024-06-14-operation-fixture",
      reportUrl: `${BLOB_BASE}/${IOCS_PATH}`,
    });
    // The nested-placement file derives its own folder campaign + blob URL.
    const phishRow = rows.find((r) => r.matchValue === "phish.volexity.test");
    expect(phishRow?.context).toEqual({
      campaign: "2024-06-15-second-fixture",
      reportUrl: `${BLOB_BASE}/${INDICATORS_PATH}`,
    });
  });
});
