// RFC 0003 F4 fan-out (#624) — ESET vendor-repo source unit tests (pure /
// disk-only, no DB). Drives the merged vendor-repo engine (#603) over the
// committed `eset-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist / context behavior is exercised end-to-end:
//   - the clean `samples.sha256` flat lists parse via `generic-list` to HASH
//     rows (no refang — bare hashes are not defanged),
//   - `.adoc` / `.yar` / `.json` are never fetched (allowlist skip), including a
//     per-folder `README.adoc` (no `readmeContext` in v1),
//   - every allowlisted file aggregates into one batch (non-clobbering), each
//     row carrying the folder→malwareFamily context + per-file blob `reportUrl`,
//   - the folder capture is case-insensitive (a mixed-case `GhostRedirector/`).

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
  "eset-fixture",
);

const BLOB_BASE =
  "https://github.com/eset/malware-ioc/blob/" +
  "06925402a23e98cbacea58bf4bd471307412956f";

const HASH_GAMAREDON_1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH_GAMAREDON_2 =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const HASH_GHOST =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function descriptor() {
  const d = getTiSourceDescriptor("eset/malware-ioc");
  if (!d) throw new Error("eset/malware-ioc descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("eset descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("eset/malware-ioc descriptor", () => {
  it("registers a vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("ESET (BSD-2-Clause)");
    expect(d.entityTypes).toEqual(["HASH"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    expect(d.classification).toBe("vendor_report");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("generic-list");
    expect(d.entityType).toBe("HASH");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("eset");
    expect(vr?.repo).toBe("malware-ioc");
    expect(vr?.ref).toBe("06925402a23e98cbacea58bf4bd471307412956f");
    expect(vr?.fixtureDir).toBe("eset-fixture");
    expect(vr?.contextPattern).toBe("^(?<malwareFamily>[^/]+)/");
    expect(vr?.reportUrlTemplate).toBe(
      "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    );
    // No flat self-fetch config — a vendor repo is fetched as a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the eset fixture tree", () => {
  it("parses samples.sha256 to HASH rows, excluding non-IOC files", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );

    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    expect(byValue.has(HASH_GAMAREDON_1)).toBe(true);
    expect(byValue.has(HASH_GAMAREDON_2)).toBe(true);
    expect(byValue.has(HASH_GHOST)).toBe(true);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.entityType).toBe("HASH");
    }

    // Only the two `samples.sha256` files are fetched; everything else is
    // allowlist-skipped (and never fetched).
    expect(fetched.sort()).toEqual([
      "GhostRedirector/samples.sha256",
      "gamaredon/samples.sha256",
    ]);
    expect(skipped).toContain("gamaredon/gamaredon.adoc");
    expect(skipped).toContain("gamaredon/rules.yar");
    expect(skipped).toContain("gamaredon/export.json");
    expect(skipped).toContain("GhostRedirector/README.adoc");
  });

  it("never reads the .adoc / .yar / .json (allowlist skip — bytes never fetched)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain("gamaredon/gamaredon.adoc");
    expect(provider.readPaths).not.toContain("gamaredon/rules.yar");
    expect(provider.readPaths).not.toContain("gamaredon/export.json");
    // Even a per-folder README.adoc is excluded in v1 (no readmeContext).
    expect(provider.readPaths).not.toContain("GhostRedirector/README.adoc");
  });

  it("does not leak a sentinel token from a skipped narrative/rule/export", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(values).not.toContain("should-never-be-fetched");
  });

  it("threads folder→malwareFamily context + per-file blob reportUrl onto each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());

    expect(byValueContext(rows, HASH_GAMAREDON_1)).toEqual({
      malwareFamily: "gamaredon",
      reportUrl: `${BLOB_BASE}/gamaredon/samples.sha256`,
    });
    expect(byValueContext(rows, HASH_GAMAREDON_2)).toEqual({
      malwareFamily: "gamaredon",
      reportUrl: `${BLOB_BASE}/gamaredon/samples.sha256`,
    });
    // Mixed-case folder name captured verbatim (case-insensitive segment match).
    expect(byValueContext(rows, HASH_GHOST)).toEqual({
      malwareFamily: "GhostRedirector",
      reportUrl: `${BLOB_BASE}/GhostRedirector/samples.sha256`,
    });
  });
});

function byValueContext(
  rows: { matchValue?: string; context?: unknown }[],
  value: string,
): unknown {
  return rows.find((r) => r.matchValue === value)?.context;
}
