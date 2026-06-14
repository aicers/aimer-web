// RFC 0003 F4 (#603) — vendor-repo importer engine unit tests (pure /
// disk-only, no DB). Covers the free-text scanner, the allowlist + context
// extraction, the per-source batch collection over a committed fixture tree
// (multi-file non-clobbering, binary/rule-file/CIB skip, the CIB downgrade
// guard), and the live GitHub provider's request shape (tree + blob API, no
// archive, optional token) with a mocked transport.

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { FetchResponseLike, FetchTransport } from "../feed-fetch";
import { parseFreeTextIocs, resolveRowHitType } from "../feed-import";
import type { VendorRepoConfig } from "../feed-source";
import {
  collectVendorRepoRows,
  deriveVendorContext,
  FixtureVendorRepoProvider,
  LiveVendorRepoProvider,
  matchVendorFileRule,
  type VendorRepoCollectInput,
  VendorRepoFetchError,
} from "../feed-vendor-repo";

const FIXTURE_ROOT = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
  "vendor-fixture",
);

const VENDOR_CONFIG: VendorRepoConfig = {
  owner: "vendor",
  repo: "ioc-reports",
  ref: "main",
  files: [
    {
      label: "iocs-csv",
      pathPattern: "reports/[^/]+/[^/]+/iocs\\.csv$",
      parse: "csv-column",
      parseConfig: {
        kind: "csv-column",
        columns: [{ name: "url", entityType: "URL" }],
        commentPrefix: "#",
      },
      entityType: "URL",
      contentClass: "malware",
    },
    {
      label: "prose-note",
      pathPattern: "reports/[^/]+/[^/]+/notes\\.md$",
      parse: "free-text",
      parseConfig: { kind: "free-text", refang: true },
      entityType: "DOMAIN",
      contentClass: "malware",
    },
    {
      label: "low-trust-list",
      pathPattern: "reports/softsource/[^/]+/indicators\\.txt$",
      parse: "generic-list",
      parseConfig: { kind: "generic-list", refang: true },
      entityType: "DOMAIN",
      contentClass: "low-trust",
      // Allowlisted but NOT deterministic: exercises the downgrade guard.
      deterministicAllowed: false,
    },
  ],
  deterministicAllowed: true,
  contextPattern: "^reports/(?<actor>[^/]+)/(?<campaign>[^/]+)/",
  reportUrlTemplate: "https://vendor.test/reports/{actor}/{campaign}",
  context: { malwareFamily: "Snake" },
};

const COLLECT_INPUT: VendorRepoCollectInput = {
  sourcePolicyId: "vendor/ioc-reports",
  entityType: "URL",
  hitType: "deterministic_ioc",
  classification: "vendor_report",
  vendorRepo: VENDOR_CONFIG,
  sourceUpdatedAt: "2026-06-14T00:00:00.000Z",
};

function resp(status: number, body: string): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
}

describe("parseFreeTextIocs (free-text scanner)", () => {
  it("pulls atomic IOCs embedded in prose, refanging by default", () => {
    const prose =
      "Beaconing to hxxps://exfil[.]turla[.]test/upload from 185[.]100[.]87[.]202; " +
      "a loader (sha256 " +
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899) " +
      "resolved cdn[.]turla[.]test before exfil.";
    expect(parseFreeTextIocs(prose)).toEqual([
      { entityType: "URL", value: "https://exfil.turla.test/upload" },
      {
        entityType: "HASH",
        value:
          "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      { entityType: "IP", value: "185.100.87.202" },
      { entityType: "DOMAIN", value: "cdn.turla.test" },
    ]);
  });

  it("does not read file extensions / words as domains", () => {
    const prose = "The dropper payload.exe wrote notes.md and config.json.";
    expect(parseFreeTextIocs(prose)).toEqual([]);
  });

  it("tolerates prose with zero IOCs (low yield is not an error)", () => {
    expect(
      parseFreeTextIocs("No indicators were recovered this time."),
    ).toEqual([]);
  });

  it("leaves defanged tokens defanged when refang is off", () => {
    // With refang off, `hxxp`/`[.]` survive, so nothing matches the URL/domain
    // shapes — the scanner yields nothing rather than a malformed indicator.
    expect(
      parseFreeTextIocs("see hxxp://evil[.]test/x", {
        kind: "free-text",
        refang: false,
      }),
    ).toEqual([]);
  });
});

describe("matchVendorFileRule (allowlist)", () => {
  it("matches allowlisted text files and skips everything else", () => {
    const match = (p: string) =>
      matchVendorFileRule(p, VENDOR_CONFIG)?.label ?? null;
    expect(match("reports/turla/snake/iocs.csv")).toBe("iocs-csv");
    expect(match("reports/turla/snake/notes.md")).toBe("prose-note");
    expect(match("reports/softsource/leaked/indicators.txt")).toBe(
      "low-trust-list",
    );
    // Binary, rule file, and CIB folder all fall through to "no rule".
    expect(match("reports/turla/snake/sample.exe")).toBeNull();
    expect(match("reports/turla/snake/detection.yar")).toBeNull();
    expect(match("reports/meta/cib-network/accounts.csv")).toBeNull();
  });
});

describe("deriveVendorContext", () => {
  it("captures actor/campaign from the path, family from static, reportUrl from template", () => {
    expect(
      deriveVendorContext("reports/turla/snake/iocs.csv", VENDOR_CONFIG),
    ).toEqual({
      actor: "turla",
      campaign: "snake",
      malwareFamily: "Snake",
      reportUrl: "https://vendor.test/reports/turla/snake",
    });
  });
});

describe("collectVendorRepoRows (per-source batch over fixture tree)", () => {
  it("aggregates every allowlisted file's rows (multi-file, non-clobbering)", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows, fetched, skipped } = await collectVendorRepoRows(
      provider,
      COLLECT_INPUT,
    );

    const values = rows.map((r) => r.matchValue);
    // Rows from THREE different files all survive in one batch — proof there is
    // no per-file replace clobber.
    expect(values).toContain("https://c2.turla.test/gate.php"); // iocs.csv
    expect(values).toContain("cdn.turla.test"); // notes.md (free-text)
    expect(values).toContain("evil.lowtrust.test"); // indicators.txt
    expect(rows).toHaveLength(8);

    // The binary sentinel, the YARA rule file, and the CIB folder are skipped.
    expect(fetched).toEqual([
      "reports/softsource/leaked/indicators.txt",
      "reports/turla/snake/iocs.csv",
      "reports/turla/snake/notes.md",
    ]);
    expect(skipped).toContain("reports/turla/snake/sample.exe");
    expect(skipped).toContain("reports/turla/snake/detection.yar");
    expect(skipped).toContain("reports/meta/cib-network/accounts.csv");
  });

  it("never fetches the binary sentinel (.exe) or rule file", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    await collectVendorRepoRows(provider, COLLECT_INPUT);
    // The ONLY byte-fetch path recorded every path it was asked for.
    expect(provider.readPaths).not.toContain("reports/turla/snake/sample.exe");
    expect(provider.readPaths).not.toContain(
      "reports/turla/snake/detection.yar",
    );
    expect(provider.readPaths).not.toContain(
      "reports/meta/cib-network/accounts.csv",
    );
  });

  it("threads report context onto each row", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, COLLECT_INPUT);
    const csvRow = rows.find(
      (r) => r.matchValue === "https://c2.turla.test/gate.php",
    );
    expect(csvRow?.context).toEqual({
      actor: "turla",
      campaign: "snake",
      malwareFamily: "Snake",
      reportUrl: "https://vendor.test/reports/turla/snake",
    });
  });

  it("downgrades a deterministicAllowed:false file's rows to soft_reputation", async () => {
    const provider = new FixtureVendorRepoProvider(FIXTURE_ROOT);
    const { rows } = await collectVendorRepoRows(provider, COLLECT_INPUT);
    const lowTrust = rows.filter((r) =>
      r.matchValue?.endsWith(".lowtrust.test"),
    );
    expect(lowTrust).toHaveLength(2);
    for (const row of lowTrust) {
      expect(row.deterministicAllowed).toBe(false);
      // The central guard forces soft_reputation even though the source default
      // is deterministic_ioc.
      expect(resolveRowHitType(row, "deterministic_ioc")).toBe(
        "soft_reputation",
      );
    }
    // A genuine malware row keeps the deterministic default.
    const csvRow = rows.find(
      (r) => r.matchValue === "https://c2.turla.test/gate.php",
    );
    expect(csvRow).toBeDefined();
    expect(resolveRowHitType(csvRow ?? {}, "deterministic_ioc")).toBe(
      "deterministic_ioc",
    );
  });
});

describe("LiveVendorRepoProvider (request shape, mocked transport)", () => {
  function recordingTransport(bodies: Record<string, FetchResponseLike>): {
    transport: FetchTransport;
    calls: { url: string; headers: Record<string, string> }[];
  } {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const transport: FetchTransport = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const match = Object.entries(bodies).find(([frag]) => url.includes(frag));
      if (!match) throw new Error(`no mock for ${url}`);
      return match[1];
    };
    return { transport, calls };
  }

  it("enumerates via the tree API and fetches only allowlisted blobs by sha", async () => {
    const treeBody = JSON.stringify({
      tree: [
        { path: "reports/turla/snake/iocs.csv", type: "blob", sha: "sha-csv" },
        {
          path: "reports/turla/snake/sample.exe",
          type: "blob",
          sha: "sha-exe",
        },
        { path: "reports/turla/snake", type: "tree", sha: "sha-dir" },
      ],
    });
    const blobBody = JSON.stringify({
      encoding: "base64",
      content: Buffer.from("firstseen,url\n2024,https://c2.test/x").toString(
        "base64",
      ),
    });
    const { transport, calls } = recordingTransport({
      "/git/trees/": resp(200, treeBody),
      "/git/blobs/sha-csv": resp(200, blobBody),
    });

    const provider = new LiveVendorRepoProvider(VENDOR_CONFIG, {
      token: "GH-TOKEN",
      transport,
      apiBase: "https://api.test",
    });
    const { fetched } = await collectVendorRepoRows(provider, COLLECT_INPUT);

    expect(fetched).toEqual(["reports/turla/snake/iocs.csv"]);
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual([
      "https://api.test/repos/vendor/ioc-reports/git/trees/main?recursive=1",
      "https://api.test/repos/vendor/ioc-reports/git/blobs/sha-csv",
    ]);
    // The binary blob's sha is NEVER fetched, and no archive path is used.
    expect(urls.some((u) => u.includes("sha-exe"))).toBe(false);
    expect(
      urls.some(
        (u) =>
          u.includes("/tarball") ||
          u.includes("/zipball") ||
          u.includes("/archive"),
      ),
    ).toBe(false);
    // The optional token is sent as a bearer credential.
    for (const call of calls) {
      expect(call.headers.Authorization).toBe("Bearer GH-TOKEN");
    }
  });

  it("works keyless (no Authorization header when no token)", async () => {
    const treeBody = JSON.stringify({ tree: [] });
    const { transport, calls } = recordingTransport({
      "/git/trees/": resp(200, treeBody),
    });
    const provider = new LiveVendorRepoProvider(VENDOR_CONFIG, {
      transport,
      apiBase: "https://api.test",
    });
    await provider.listTree();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("wraps a non-2xx response in VendorRepoFetchError (no good snapshot lost)", async () => {
    const { transport } = recordingTransport({
      "/git/trees/": resp(404, "not found"),
    });
    const provider = new LiveVendorRepoProvider(VENDOR_CONFIG, {
      transport,
      apiBase: "https://api.test",
    });
    await expect(provider.listTree()).rejects.toThrowError(
      VendorRepoFetchError,
    );
  });

  it("wraps a transport rejection in VendorRepoFetchError", async () => {
    const transport: FetchTransport = async () => {
      throw new Error("ECONNRESET");
    };
    const provider = new LiveVendorRepoProvider(VENDOR_CONFIG, {
      transport,
      apiBase: "https://api.test",
    });
    await expect(provider.listTree()).rejects.toThrowError(
      VendorRepoFetchError,
    );
  });

  it("readBlob before listTree throws (no blob sha resolved yet)", async () => {
    const { transport } = recordingTransport({});
    const provider = new LiveVendorRepoProvider(VENDOR_CONFIG, {
      transport,
      apiBase: "https://api.test",
    });
    await expect(
      provider.readBlob("reports/turla/snake/iocs.csv"),
    ).rejects.toThrowError(VendorRepoFetchError);
  });
});
