// RFC 0003 F4 fan-out (#629) — Meta Threat Research vendor-repo source unit
// tests (pure / disk-only, no DB). Drives the merged vendor-repo engine (#603)
// over the committed `meta-fixture/` tree using the REAL descriptor config, so
// the descriptor's allowlist / CIB downgrade / refang behavior is exercised
// end-to-end:
//   - the CIB CSV's count/narrative SENTINELS (`154 Accounts`, `23 Pages`, the
//     prose sentence) are NOT emitted (they match no IOC shape), while its real
//     `[.]`-defanged domain and the legacy CSV's atomic IOCs ARE,
//   - EVERY emitted row is forced to `soft_reputation` by the repo-level
//     `deterministicAllowed: false` guard — never `deterministic_ioc`, even when
//     a deterministic default is supplied (the CIB-guard showcase),
//   - `.tsv` / `.json` / `.stix1` / `.md` / `.DS_Store` / `signatures/yara/` are
//     never fetched (allowlist skip, asserted via `readPaths`),
//   - both allowlisted CSVs aggregate into ONE batch (non-clobbering).

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveRowHitType } from "../../feed-import";
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
  "meta-fixture",
);

const CIB_DOMAIN = "cib-network.example";
const LEGACY_URL = "https://legacy-malware.example/payload.bin";
const LEGACY_DOMAIN = "c2-legacy.example";
const LEGACY_HASH =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const CIB_CSV = "indicators/csv/H1_2024/cib-network.csv";
const LEGACY_CSV = "indicators/csv/2020/legacy-malware.csv";

const EXCLUDED_PATHS = [
  "indicators/tsv/H1_2024/cib-network.tsv",
  "indicators/json/2020/legacy-malware.json",
  "indicators/stix1/2020/legacy-malware.xml",
  "README.md",
  ".DS_Store",
  "signatures/yara/example.yar",
];

function descriptor() {
  const d = getTiSourceDescriptor("meta/threat-research");
  if (!d) throw new Error("meta/threat-research descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("meta descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("meta/threat-research descriptor", () => {
  it("registers a CIB vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("Meta Threat Research (MIT)");
    expect(d.entityTypes).toEqual(["DOMAIN", "URL", "IP", "HASH"]);
    expect(d.floorEligible).toBe(false);
    // CIB / influence-ops context is neither coverage-deterministic nor a
    // floor source; its rows are soft reputation by construction.
    expect(d.deterministicCoverage).toBe(false);
    expect(d.hitType).toBe("soft_reputation");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("DOMAIN");
    expect(d.classification).toBe("vendor-cib");

    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("facebook");
    expect(vr?.repo).toBe("threat-research");
    expect(vr?.ref).toBe("a1b05bff1c29fe32e116c4a5eb35b0f0d4e717b1");
    expect(vr?.fixtureDir).toBe("meta-fixture");
    // The load-bearing CIB guard.
    expect(vr?.deterministicAllowed).toBe(false);
    // A single allowlist rule over every CSV under indicators/csv/**.
    expect(vr?.files).toHaveLength(1);
    expect(vr?.files[0]?.pathPattern).toBe("indicators/csv/.*\\.csv$");
    expect(vr?.files[0]?.contentClass).toBe("cib");
    // No per-file blob URL / path context (Meta's paths defeat both — see the
    // descriptor header). No flat fixture / self-fetch config either.
    expect(vr?.reportUrlTemplate).toBeUndefined();
    expect(vr?.contextPattern).toBeUndefined();
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the meta fixture tree", () => {
  it("drops CIB count/narrative sentinels while emitting real value-shaped IOCs", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "");

    // The real indicators emit: the CIB file's defanged domain (refanged) and
    // the legacy file's URL / domain / hash.
    expect(values).toContain(CIB_DOMAIN);
    expect(values).toContain(LEGACY_URL);
    expect(values).toContain(LEGACY_DOMAIN);
    expect(values).toContain(LEGACY_HASH);
    expect(rows).toHaveLength(4);

    // The count / page / narrative SENTINELS are NOT emitted — numbers and bare
    // words match no IOC shape, so the `Indicator` column's CIB asset counts and
    // the prose sentence never become indicators.
    const joined = values.join(" ");
    expect(joined).not.toContain("Accounts");
    expect(joined).not.toContain("154");
    expect(joined).not.toContain("Pages");
    expect(joined).not.toContain("23");
    expect(joined).not.toContain("inauthentic");
    expect(joined).not.toContain("messaging");
  });

  it("self-classifies each emitted token's entity type by value shape", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    expect(byValue.get(CIB_DOMAIN)?.entityType).toBe("DOMAIN");
    expect(byValue.get(LEGACY_URL)?.entityType).toBe("URL");
    expect(byValue.get(LEGACY_DOMAIN)?.entityType).toBe("DOMAIN");
    expect(byValue.get(LEGACY_HASH)?.entityType).toBe("HASH");
  });

  it("forces EVERY row to soft_reputation via the repo-level CIB guard", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    // The central CIB downgrade: a `deterministicAllowed: false` row resolves to
    // `soft_reputation` regardless of the snapshot default — even if a
    // deterministic default were (wrongly) supplied, no row can become a
    // deterministic / floor-eligible hit.
    for (const row of rows) {
      expect(row.deterministicAllowed).toBe(false);
      expect(resolveRowHitType(row, "soft_reputation")).toBe("soft_reputation");
      expect(resolveRowHitType(row, "deterministic_ioc")).toBe(
        "soft_reputation",
      );
    }
  });

  it("aggregates both allowlisted CSVs into one batch, skipping everything else", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );
    // Only the two CSVs are fetched; both feed one aggregated row set.
    expect(fetched.sort()).toEqual([LEGACY_CSV, CIB_CSV].sort());
    for (const path of EXCLUDED_PATHS) {
      expect(skipped).toContain(path);
    }
  });

  it("never reads the excluded files (bytes never fetched, asserted via readPaths)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    for (const path of EXCLUDED_PATHS) {
      expect(provider.readPaths).not.toContain(path);
    }
    // Sanity: only the two allowlisted CSVs were ever read.
    expect(provider.readPaths.sort()).toEqual([LEGACY_CSV, CIB_CSV].sort());
  });

  it("does not leak a sentinel token from any skipped file", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const joined = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(joined).not.toContain("should-never-be-fetched");
  });
});
