// RFC 0003 F4 fan-out (#626) — PRODAFT vendor-repo source unit tests (pure /
// disk-only, no DB). Drives the merged vendor-repo engine (#603) over the
// committed `prodaft-fixture/` tree using the REAL descriptor config, so the
// descriptor's allowlist / context / refang behavior is exercised end-to-end:
//   - per-investigation `README.md` reports parse via `free-text` to normalized
//     IP/DOMAIN/URL/HASH rows (Markdown tables + fenced code blocks; a defanged
//     `hxxps[://]` link refanged),
//   - the LIVE `.exe` decryptor sentinel (and the `images/` / `.pdf`) are NEVER
//     fetched (the enforce-by-default allowlist skip — the binary-guard
//     showcase), and the root `README.md` is excluded by the `.+/` rule,
//   - every allowlisted file aggregates into one batch (non-clobbering), each
//     row carrying its folder codename as `actor` + the per-file blob
//     `reportUrl` from `reportUrlTemplate`.

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectVendorRepoRows,
  FixtureVendorRepoProvider,
  matchVendorFileRule,
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
  "prodaft-fixture",
);

const BLOB_BASE =
  "https://github.com/prodaft/malware-ioc/blob/" +
  "6ecbec2f66cf18ea869e596ef451a072539ae588";

function descriptor() {
  const d = getTiSourceDescriptor("prodaft/malware-ioc");
  if (!d) throw new Error("prodaft/malware-ioc descriptor not registered");
  return d;
}

function collectInput(): VendorRepoCollectInput {
  const d = descriptor();
  if (!d.vendorRepo) throw new Error("prodaft descriptor missing vendorRepo");
  return {
    sourcePolicyId: d.sourcePolicyId,
    entityType: d.entityType,
    hitType: d.hitType,
    classification: d.classification,
    vendorRepo: d.vendorRepo,
    sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
  };
}

describe("prodaft/malware-ioc descriptor", () => {
  it("registers a vendor-repo source pinned to a master SHA + fixtureDir", () => {
    const d = descriptor();
    expect(d.label).toBe("PRODAFT (MIT)");
    expect(d.entityTypes).toEqual(["IP", "DOMAIN", "URL", "HASH"]);
    expect(d.floorEligible).toBe(false);
    expect(d.deterministicCoverage).toBe(true);
    expect(d.hitType).toBe("deterministic_ioc");
    expect(d.classification).toBe("vendor-report");
    // Required import-time defaults even for a vendor-repo source.
    expect(d.parse).toBe("free-text");
    expect(d.entityType).toBe("IP");
    const vr = d.vendorRepo;
    expect(vr?.owner).toBe("prodaft");
    expect(vr?.repo).toBe("malware-ioc");
    expect(vr?.ref).toBe("6ecbec2f66cf18ea869e596ef451a072539ae588");
    expect(vr?.fixtureDir).toBe("prodaft-fixture");
    expect(vr?.contextPattern).toBe("^(?<actor>[^/]+)/");
    expect(vr?.reportUrlTemplate).toBe(
      "https://github.com/{owner}/{repo}/blob/{ref}/{path}",
    );
    // No flat self-fetch / single-file config — a vendor repo is a tree.
    expect(d.fetch).toBeUndefined();
    expect(d.fixtureFile).toBeUndefined();
  });

  it("allowlists per-investigation READMEs but skips the .exe / images / pdf / root README", () => {
    const vr = descriptor().vendorRepo;
    if (!vr) throw new Error("prodaft descriptor missing vendorRepo");
    // Investigation READMEs match.
    expect(matchVendorFileRule("RagnarLoader/README.md", vr)).toBeDefined();
    expect(matchVendorFileRule("Matanbuchus/README.md", vr)).toBeDefined();
    // The binary-guard showcase: the live `.exe` matches NO rule (never
    // fetched), as do the image / PDF and the root README.
    expect(
      matchVendorFileRule("RagnarLoader/decryptor.exe", vr),
    ).toBeUndefined();
    expect(
      matchVendorFileRule("RagnarLoader/images/banner.jpeg", vr),
    ).toBeUndefined();
    expect(matchVendorFileRule("RagnarLoader/report.pdf", vr)).toBeUndefined();
    expect(matchVendorFileRule("README.md", vr)).toBeUndefined();
  });
});

describe("collectVendorRepoRows over the prodaft fixture tree", () => {
  it("parses README tables + code blocks to normalized IP/DOMAIN/URL/HASH rows (refang)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      collectInput(),
    );

    const byValue = new Map(rows.map((r) => [r.matchValue, r]));
    // RagnarLoader/README.md — code-block IP / domain, a refanged `hxxps[://]`
    // URL (host masked, not re-scanned as a domain), and two table SHA256s.
    expect(byValue.get("185.220.101.42")?.entityType).toBe("IP");
    expect(byValue.get("ragnar-c2.prodaft.test")?.entityType).toBe("DOMAIN");
    expect(byValue.get("https://malware.ragnar.test/loader")?.entityType).toBe(
      "URL",
    );
    expect(
      byValue.get(
        "aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900",
      )?.entityType,
    ).toBe("HASH");
    expect(
      byValue.has(
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      ),
    ).toBe(true);
    // Matanbuchus/README.md — one IP, one domain, one table SHA256.
    expect(byValue.get("198.51.100.23")?.entityType).toBe("IP");
    expect(byValue.get("matanbuchus-panel.prodaft.test")?.entityType).toBe(
      "DOMAIN",
    );
    expect(
      byValue.has(
        "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
      ),
    ).toBe(true);
    // Exactly the eight indicators above — no stray rows from prose / filenames.
    expect(rows).toHaveLength(8);

    // Only the two investigation READMEs are fetched; everything else is
    // allowlist-skipped (the `.exe` sentinel, the image, the PDF, the root
    // README).
    expect(fetched.sort()).toEqual([
      "Matanbuchus/README.md",
      "RagnarLoader/README.md",
    ]);
    expect(skipped).toContain("RagnarLoader/decryptor.exe");
    expect(skipped).toContain("RagnarLoader/images/banner.jpeg");
    expect(skipped).toContain("RagnarLoader/report.pdf");
    expect(skipped).toContain("README.md");
  });

  it("never reads the live .exe / image / pdf / root README (bytes never fetched)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, collectInput());
    expect(provider.readPaths).not.toContain("RagnarLoader/decryptor.exe");
    expect(provider.readPaths).not.toContain("RagnarLoader/images/banner.jpeg");
    expect(provider.readPaths).not.toContain("RagnarLoader/report.pdf");
    expect(provider.readPaths).not.toContain("README.md");
    // Exactly the two allowlisted READMEs were ever read.
    expect(provider.readPaths.sort()).toEqual([
      "Matanbuchus/README.md",
      "RagnarLoader/README.md",
    ]);
  });

  it("does not leak a sentinel token from a skipped binary / image / pdf / root README", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const values = rows.map((r) => r.matchValue ?? "").join(" ");
    expect(values).not.toContain("should-never-be-fetched");
    expect(values).not.toContain("evil-decryptor.never.test");
    expect(values).not.toContain("203.0.113.66");
    expect(values).not.toContain("banner-image.never.test");
    expect(values).not.toContain("report-pdf.never.test");
    expect(values).not.toContain("root-readme.never.test");
  });

  it("attaches the folder codename as actor + the per-file blob reportUrl", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, collectInput());
    const ragnarRow = rows.find((r) => r.matchValue === "185.220.101.42");
    expect(ragnarRow?.context).toEqual({
      actor: "RagnarLoader",
      reportUrl: `${BLOB_BASE}/RagnarLoader/README.md`,
    });
    const matanRow = rows.find(
      (r) => r.matchValue === "matanbuchus-panel.prodaft.test",
    );
    expect(matanRow?.context).toEqual({
      actor: "Matanbuchus",
      reportUrl: `${BLOB_BASE}/Matanbuchus/README.md`,
    });
  });
});
