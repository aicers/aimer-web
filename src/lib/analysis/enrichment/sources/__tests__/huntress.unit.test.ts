// RFC 0003 F4 fan-out (#628) — Huntress vendor-repo source unit tests (pure /
// disk-only, no DB). Drives the merged vendor-repo engine (#603) over the
// committed `huntress-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist + the `keepLinePattern` type-allowlist (#628) are
// exercised end-to-end:
//   - the `type,data,info` CSVs parse via `free-text` to normalized
//     IP/DOMAIN/URL/HASH rows (defang refanged), gated by the type-allowlist,
//   - the FOUR false-positive junk rows (the `description` blog URL, the
//     `sig:Defender` domain-like value, the `ssl_certificate_serial` hex, the
//     `url_path` `window.open`) are NEVER emitted — the core regression guard,
//   - `.yml` / `.yar` / `.ps1` / `.DS_Store` are never fetched (allowlist skip),
//   - both CSVs aggregate into ONE batch (non-clobbering), each row carrying the
//     filename-derived incident `campaign`.

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
  "huntress-fixture",
);

const GENTLEMEN = "2026/2026-05/20260521_gentlemen.csv";
const FILELESS = "2026/2026-05/20260518_fileless-loader-rat.csv";
// Mixed-case incident filename — exercises the case-insensitive contextPattern
// (a lowercase-only class silently fails to capture `kali365-IoCs`).
const KALI365 = "2026/2026-06/20260611_kali365-IoCs.csv";

function descriptor() {
  const d = getTiSourceDescriptor("huntress/threat-intel");
  if (!d) throw new Error("huntress/threat-intel descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("huntress descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("huntress/threat-intel descriptor", () => {
  it("registers a vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("Huntress (MIT)");
    expect(d.entityTypes).toEqual(["IP", "DOMAIN", "URL", "HASH"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("IP");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("huntresslabs");
    expect(vr?.repo).toBe("threat-intel");
    expect(vr?.ref).toBe("8fda9d338049111f29e5f68e053b9315eefa759b");
    expect(vr?.fixtureDir).toBe("huntress-fixture");
    // The single CSV rule carries the type-allowlist; no per-file reportUrl.
    expect(vr?.files).toHaveLength(1);
    expect(vr?.files[0]?.pathPattern).toBe("\\.csv$");
    expect(vr?.files[0]?.parseConfig).toMatchObject({
      kind: "free-text",
      refang: true,
    });
    expect(vr?.reportUrlTemplate).toBeUndefined();
    // No flat self-fetch config — a vendor repo is fetched as a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the huntress fixture tree", () => {
  it("parses the atomic-IOC CSV rows (refang), one batch across both CSVs", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );
    const byValue = new Map(rows.map((r) => [r.matchValue, r]));

    // Gentlemen CSV — the real atomic rows survive the type-allowlist.
    expect(
      byValue.has(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBe(true);
    expect(byValue.get("45.137.21.8")?.entityType).toBe("IP"); // defanged → refanged
    expect(byValue.get("193.233.202.17")?.entityType).toBe("IP"); // ip:port → bare IP
    expect(byValue.get("gentlemen-leak.example")?.entityType).toBe("DOMAIN");
    expect(
      byValue.get("https://gentlemen-leak.example/login")?.entityType,
    ).toBe("URL");
    // Fileless-loader CSV — aggregated into the SAME batch.
    expect(
      byValue.has(
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ),
    ).toBe(true);
    expect(byValue.get("rat-c2.example")?.entityType).toBe("DOMAIN");
    // Mixed-case incident CSV — its atomic rows survive too.
    expect(
      byValue.has(
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      ),
    ).toBe(true);
    expect(byValue.get("kali365-panel.example")?.entityType).toBe("DOMAIN");
    expect(byValue.get("185.234.72.19")?.entityType).toBe("IP");

    // All three CSVs fetched; nothing else.
    expect(fetched.sort()).toEqual([FILELESS, GENTLEMEN, KALI365].sort());
    expect(skipped).toContain("2026/2026-05/sigma/suspicious_loader.yml");
    expect(skipped).toContain("2026/2026-05/yara/loader.yar");
    expect(skipped).toContain("2026/2026-05/collect.ps1");
    expect(skipped).toContain("2026/2026-05/.DS_Store");
  });

  it("does NOT emit any of the four junk-type false positives", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "");
    const joined = values.join(" ");
    // 1. `description` blog URLs (URL) — both CSVs' metadata rows.
    expect(joined).not.toContain("huntress.com/blog");
    // 2. `sig:Defender` domain-like value (DOMAIN).
    expect(values).not.toContain("BlackByte.SZ");
    expect(joined).not.toContain("BlackByte");
    // 3. `ssl_certificate_serial` hex (HASH — MD5 shape).
    expect(values).not.toContain("00f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5");
    // 4. `url_path` `window.open` (DOMAIN).
    expect(joined).not.toContain("window.open");
  });

  it("does NOT emit a bare host IP from a CIDR-shaped `ip` row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "");
    // `ip,43.173.64.0/18` is a /18 network, not a host. The keepLinePattern
    // rejects CIDR-shaped `ip` rows so the value-shape scanner never extracts
    // the bare `43.173.64.0` as a misleading exact-host IOC.
    expect(values).not.toContain("43.173.64.0");
    expect(values.join(" ")).not.toContain("43.173.64.0");
  });

  it("never reads the .yml / .yar / .ps1 / .DS_Store (allowlist skip — bytes never fetched)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain(
      "2026/2026-05/sigma/suspicious_loader.yml",
    );
    expect(provider.readPaths).not.toContain("2026/2026-05/yara/loader.yar");
    expect(provider.readPaths).not.toContain("2026/2026-05/collect.ps1");
    expect(provider.readPaths).not.toContain("2026/2026-05/.DS_Store");
    // No sentinel from a never-fetched rule/script file leaks into the rows.
    const joined = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(joined).not.toContain("should-never-be-fetched");
    expect(joined).not.toContain("never-fetched-host");
    expect(joined).not.toContain("script-sentinel");
  });

  it("threads the filename-derived incident campaign onto each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    expect(byValue.get("45.137.21.8")?.context).toEqual({
      campaign: "gentlemen",
    });
    expect(byValue.get("rat-c2.example")?.context).toEqual({
      campaign: "fileless-loader-rat",
    });
    // Mixed-case filename — the case-insensitive contextPattern captures the
    // incident name verbatim (a lowercase-only class would drop it).
    expect(byValue.get("185.234.72.19")?.context).toEqual({
      campaign: "kali365-IoCs",
    });
  });
});
