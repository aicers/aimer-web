// RFC 0003 F4 fan-out (#623) — Palo Alto Unit 42 vendor-repo source unit tests
// (pure / disk-only, no DB). Drives the merged vendor-repo engine (#603) over
// the committed `unit42-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist / context / refang behavior is exercised end-to-end:
//   - the defanged `.txt` lists parse via `free-text` to normalized
//     IP/DOMAIN/URL/HASH rows (partial / `hXXp` defang refanged),
//   - `.pdf` / `.py` are never fetched (allowlist skip), `.md` is excluded,
//   - every allowlisted file aggregates into one batch (non-clobbering), each
//     row carrying the per-file blob `reportUrl` from `reportUrlTemplate`.

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
  "unit42-fixture",
);

const BLOB_BASE =
  "https://github.com/PaloAltoNetworks/" +
  "Unit42-Threat-Intelligence-Article-Information/blob/" +
  "68070f9858bc85147fd36e652c84529df9225dba";

function descriptor() {
  const d = getTiSourceDescriptor("unit42/threat-intel");
  if (!d) throw new Error("unit42/threat-intel descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("unit42 descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("unit42/threat-intel descriptor", () => {
  it("registers a vendor-repo source with the pinned repo + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("Palo Alto Unit 42 (Unlicense)");
    expect(d.entityTypes).toEqual(["IP", "DOMAIN", "URL", "HASH"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("IP");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("PaloAltoNetworks");
    expect(vr?.repo).toBe("Unit42-Threat-Intelligence-Article-Information");
    expect(vr?.ref).toBe("68070f9858bc85147fd36e652c84529df9225dba");
    expect(vr?.fixtureDir).toBe("unit42-fixture");
    expect(vr?.reportUrlTemplate).toBe(
      "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    );
    // No flat self-fetch config — a vendor repo is fetched as a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the unit42 fixture tree", () => {
  it("parses defanged .txt lists to normalized rows (refang), excluding non-IOC files", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );

    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    // CL-STA-0910-iocs.txt — `hXXps` + partial `[.]` brackets refanged.
    expect(byValue.has("https://malware.unit42.test/payload")).toBe(true);
    expect(byValue.has("185.178.208.153")).toBe(true);
    expect(byValue.has("phish.unit42.test")).toBe(true);
    expect(
      byValue.has(
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      ),
    ).toBe(true);
    // CL-CRI-1147-hashes.txt — a pure SHA256 dump.
    expect(
      byValue.has(
        "1111111111111111111111111111111111111111111111111111111111111111",
      ),
    ).toBe(true);
    expect(
      byValue.has(
        "2222222222222222222222222222222222222222222222222222222222222222",
      ),
    ).toBe(true);
    expect(rows).toHaveLength(6);

    // Per-token self-classification by value shape.
    expect(byValue.get("https://malware.unit42.test/payload")?.entityType).toBe(
      "URL",
    );
    expect(byValue.get("185.178.208.153")?.entityType).toBe("IP");
    expect(byValue.get("phish.unit42.test")?.entityType).toBe("DOMAIN");
    expect(
      byValue.get(
        "1111111111111111111111111111111111111111111111111111111111111111",
      )?.entityType,
    ).toBe("HASH");

    // Only the two `.txt` files are fetched; everything else is allowlist-skipped.
    expect(fetched.sort()).toEqual([
      "CL-CRI-1147-hashes.txt",
      "CL-STA-0910-iocs.txt",
    ]);
    expect(skipped).toContain("appendix.md");
    expect(skipped).toContain("extract.py");
    expect(skipped).toContain("report.pdf");
  });

  it("never reads the .pdf / .py / .md (allowlist skip — bytes never fetched)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain("report.pdf");
    expect(provider.readPaths).not.toContain("extract.py");
    expect(provider.readPaths).not.toContain("appendix.md");
  });

  it("does not leak a sentinel token from a skipped binary/script/markdown", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(values).not.toContain("should-never-be-fetched");
    expect(values).not.toContain("not-a-real.dll");
  });

  it("threads per-file blob reportUrl + filename cluster id onto each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const iocRow = rows.find(
      (r) => r.matchValue === "https://malware.unit42.test/payload",
    );
    expect(iocRow?.context).toEqual({
      campaign: "CL-STA-0910",
      reportUrl: `${BLOB_BASE}/CL-STA-0910-iocs.txt`,
    });
    const hashRow = rows.find(
      (r) =>
        r.matchValue ===
        "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(hashRow?.context).toEqual({
      campaign: "CL-CRI-1147",
      reportUrl: `${BLOB_BASE}/CL-CRI-1147-hashes.txt`,
    });
  });
});
