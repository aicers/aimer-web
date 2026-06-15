// RFC 0003 F4 fan-out (#627) — Zscaler ThreatLabz vendor-repo source unit tests
// (pure / disk-only, no DB). Drives the merged vendor-repo engine (#603) over
// the committed `zscaler-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist / context / refang behavior is exercised end-to-end:
//   - the `.txt` lists parse via `free-text` to normalized IP/DOMAIN/URL/HASH
//     rows (inconsistent defang refanged; `IP:port` → bare IP; `#` header lines
//     yield no rows),
//   - the concatenated-domain `qakbot/payload_urls.txt` is excluded by the
//     allowlist negative lookahead and never fetched,
//   - the PII `.csv`, the CS `.json`, and the `.php` are excluded (no matching
//     rule) and never fetched — their sentinels never reach the snapshot,
//   - the folder name attaches as `campaign`, and every allowlisted file
//     aggregates into one batch.

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
  "zscaler-fixture",
);

function descriptor() {
  const d = getTiSourceDescriptor("zscaler/threatlabz");
  if (!d) throw new Error("zscaler/threatlabz descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("zscaler descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("zscaler/threatlabz descriptor", () => {
  it("registers a vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("Zscaler ThreatLabz (MIT)");
    expect(d.entityTypes).toEqual(["IP", "DOMAIN", "URL", "HASH"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    expect(d.classification).toBe("vendor_report");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("IP");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("threatlabz");
    expect(vr?.repo).toBe("iocs");
    expect(vr?.ref).toBe("5f73ebab40a921d24acbdafd4b8c0861db21d0af");
    expect(vr?.fixtureDir).toBe("zscaler-fixture");
    expect(vr?.contextPattern).toBe("^(?<campaign>[^/]+)/");
    // Folder name only — no report link / manifest in this repo.
    expect(vr?.reportUrlTemplate).toBeUndefined();
    // No flat self-fetch config — a vendor repo is fetched as a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the zscaler fixture tree", () => {
  it("parses .txt lists to normalized rows (refang, IP:port → bare IP)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());

    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    // c2_ips.txt — the defanged `185[.]100[.]87[.]202:8080` refangs and the
    // word-boundary IPv4 scan drops `:8080`, leaving the bare IP.
    expect(byValue.has("185.100.87.202")).toBe(true);
    expect(byValue.has("45.155.205.99")).toBe(true);
    // hashes.txt — a pure SHA256 dump.
    expect(
      byValue.has(
        "3333333333333333333333333333333333333333333333333333333333333333",
      ),
    ).toBe(true);
    expect(
      byValue.has(
        "4444444444444444444444444444444444444444444444444444444444444444",
      ),
    ).toBe(true);
    // mixed_iocs.txt — defanged DOMAIN + URL lines refanged.
    expect(byValue.has("cdn.turla.test")).toBe(true);
    expect(byValue.has("https://exfil.turla.test/x")).toBe(true);
    // Exactly the four `.txt`-parsed rows plus the two mixed rows; the `#`
    // section-header lines carry no IOC token and yield nothing.
    expect(rows).toHaveLength(6);

    // Per-token self-classification by value shape across all four types.
    expect(byValue.get("185.100.87.202")?.entityType).toBe("IP");
    expect(
      byValue.get(
        "3333333333333333333333333333333333333333333333333333333333333333",
      )?.entityType,
    ).toBe("HASH");
    expect(byValue.get("cdn.turla.test")?.entityType).toBe("DOMAIN");
    expect(byValue.get("https://exfil.turla.test/x")?.entityType).toBe("URL");
  });

  it("excludes the concatenated-domain payload_urls.txt and the PII / config / script files", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );

    // Only the three allowlisted `.txt` files are fetched (in tree order).
    expect(fetched.sort()).toEqual([
      "qakbot/c2_ips.txt",
      "qakbot/hashes.txt",
      "qakbot/mixed_iocs.txt",
    ]);
    // The known-bad concatenated-domain file and every non-`.txt` file are
    // allowlist-skipped.
    expect(skipped).toContain("qakbot/payload_urls.txt");
    expect(skipped).toContain("qakbot/phantomprayers_check_in_data.csv");
    expect(skipped).toContain("qakbot/beacon_config.json");
    expect(skipped).toContain("qakbot/dropper_template.php");

    // The run-together garbage domain is never imported.
    const values = rows.map((r) => r.matchValue ?? "");
    expect(values).not.toContain("anukulvivah.comnobeltech.com.pk");
  });

  it("never reads the excluded files (bytes never fetched — readPaths)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain("qakbot/payload_urls.txt");
    expect(provider.readPaths).not.toContain(
      "qakbot/phantomprayers_check_in_data.csv",
    );
    expect(provider.readPaths).not.toContain("qakbot/beacon_config.json");
    expect(provider.readPaths).not.toContain("qakbot/dropper_template.php");
  });

  it("does not leak a sentinel token from the skipped PII / config / script files", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    // Victim-PII telemetry (synthetic sentinel): the documentation-range IP and
    // the email host must never appear.
    expect(values).not.toContain("203.0.113.7");
    expect(values).not.toContain("example.test");
    // CS beacon-config + PHP-template host tokens.
    expect(values).not.toContain("should-never-be-fetched");
  });

  it("attaches the folder name as campaign context on each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.context).toEqual({ campaign: "qakbot" });
    }
  });
});
