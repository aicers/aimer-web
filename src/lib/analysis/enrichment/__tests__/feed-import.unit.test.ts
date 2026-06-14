// RFC 0003 P1a (#361) — feed parser + normalization unit tests (pure, no
// DB). The DB import path (`importFeedSnapshot`) is covered by the worker
// db tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeFeedHash,
  FeedParseError,
  hasFeedDataLines,
  isUnparseableFeedContent,
  normalizeCidrs,
  normalizeExactValues,
  parseCsvColumns,
  parseFeedContent,
  parseGenericList,
  parseIpBlocklist,
  parseSpamhausDrop,
  parseUrlhausCsv,
  parseUrlhausHosts,
  parseUrlhausPayloadsCsv,
  refangIndicator,
} from "../feed-import";
import type {
  CsvColumnParseConfig,
  GenericListParseConfig,
} from "../feed-source";

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

describe("feed parsers", () => {
  it("parses a Feodo-style IP blocklist, skipping comments", () => {
    const text = "# header\n203.0.113.10\n\n198.51.100.50\n# trailing";
    expect(parseIpBlocklist(text)).toEqual(["203.0.113.10", "198.51.100.50"]);
  });

  it("parses URLhaus CSV, taking the URL column and skipping the header", () => {
    const text = [
      "# id,dateadded,url,url_status",
      '"1","2026-05-01","http://malware.example/a.exe","online"',
      '"2","2026-05-01","https://c2.example.test/gate.php","online"',
    ].join("\n");
    expect(parseUrlhausCsv(text)).toEqual([
      "http://malware.example/a.exe",
      "https://c2.example.test/gate.php",
    ]);
  });

  it("extracts URLhaus URL hosts as DOMAINs, skipping IP hosts", () => {
    const hosts = parseUrlhausHosts([
      "http://malware.example/a.exe",
      "https://c2.example.test/gate.php",
      "http://198.51.100.7/payload", // IPv4 host → skipped (covered by IP feeds)
      "http://[2001:db8::1]/x", // IPv6 host → skipped
      "not a url", // unparseable → skipped
    ]);
    expect(hosts).toEqual(["malware.example", "c2.example.test"]);
  });

  it("parses URLhaus payloads CSV, taking the MD5 and SHA-256 hash columns", () => {
    const md5 = "0123456789abcdef0123456789abcdef";
    const sha256 = `${md5}${md5}`;
    const text = [
      "# firstseen,urlhaus_link,filetype,md5_hash,sha256_hash,signature",
      `"2026-05-01","https://urlhaus.abuse.ch/url/1/","exe","${md5}","${sha256}","Emotet"`,
      // A row missing the sha256 column still yields its md5.
      '"2026-05-01","https://urlhaus.abuse.ch/url/2/","dll","fedcba9876543210fedcba9876543210","",""',
    ].join("\n");
    expect(parseUrlhausPayloadsCsv(text)).toEqual([
      md5,
      sha256,
      "fedcba9876543210fedcba9876543210",
    ]);
  });

  it("parses Spamhaus DROP, taking the CIDR and dropping the SBL comment", () => {
    const text = "; comment\n192.0.2.0/24 ; SBL1\n198.51.100.0/24 ; SBL2";
    expect(parseSpamhausDrop(text)).toEqual([
      "192.0.2.0/24",
      "198.51.100.0/24",
    ]);
  });
});

describe("refangIndicator", () => {
  it("refangs scheme, dots, and at", () => {
    expect(refangIndicator("hxxp://malware[.]example/a[.]exe")).toBe(
      "http://malware.example/a.exe",
    );
    expect(refangIndicator("hxxps://c2(.)evil(.)example")).toBe(
      "https://c2.evil.example",
    );
    expect(refangIndicator("admin[at]evil[.]example")).toBe(
      "admin@evil.example",
    );
  });

  it("leaves an already-fanged indicator unchanged", () => {
    expect(refangIndicator("http://malware.example/a.exe")).toBe(
      "http://malware.example/a.exe",
    );
  });
});

describe("parseGenericList (#593)", () => {
  it("parses a plain list, stripping #/; comments and blanks", () => {
    expect(parseGenericList(fixture("generic-list-domains.txt"))).toEqual([
      "bad-domain.example",
      "c2.evil.example",
      "phishing.evil.example",
    ]);
  });

  it("leaves defanged indicators alone when refang is off", () => {
    const cfg: GenericListParseConfig = { kind: "generic-list", refang: false };
    expect(parseGenericList("hxxp://evil[.]example/x", cfg)).toEqual([
      "hxxp://evil[.]example/x",
    ]);
  });

  it("refangs each line when refang is on", () => {
    const cfg: GenericListParseConfig = { kind: "generic-list", refang: true };
    expect(parseGenericList(fixture("generic-list-defanged.txt"), cfg)).toEqual(
      [
        "http://malware.example/a.exe",
        "https://c2.evil.example/gate.php",
        "admin@evil.example",
      ],
    );
  });

  it("honors a custom comment-prefix set", () => {
    const cfg: GenericListParseConfig = {
      kind: "generic-list",
      commentPrefixes: ["//"],
    };
    // `;` is no longer a comment here, so its line is kept as data.
    expect(parseGenericList("// note\n; kept\na.example", cfg)).toEqual([
      "; kept",
      "a.example",
    ]);
  });

  it("expresses ip-blocklist as generic-list with entityType IP (parity)", () => {
    const text = "# header\n203.0.113.10\n\n198.51.100.50\n# trailing";
    expect(
      parseFeedContent("generic-list", "IP", text, { kind: "generic-list" }),
    ).toEqual(parseFeedContent("ip-blocklist", "IP", text));
  });
});

describe("parseCsvColumns (#593)", () => {
  it("selects a column by header name and skips the header", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "url", entityType: "URL" }],
      skipHeader: true,
      commentPrefix: "#",
    };
    expect(parseCsvColumns(fixture("csv-column-sample.csv"), cfg)).toEqual([
      { entityType: "URL", value: "http://malware.example/a.exe" },
      { entityType: "URL", value: "https://c2.evil.example/gate.php" },
      { entityType: "URL", value: "http://phishing.evil.example/login" },
    ]);
  });

  it("selects a column by zero-based index", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 0, entityType: "IP" }],
    };
    // No header skip: every non-comment line is data.
    expect(parseCsvColumns("1.2.3.4,foo\n5.6.7.8,bar", cfg)).toEqual([
      { entityType: "IP", value: "1.2.3.4" },
      { entityType: "IP", value: "5.6.7.8" },
    ]);
  });

  it("extracts multiple columns with per-column entity types", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [
        { name: "url", entityType: "URL" },
        { name: "host", entityType: "DOMAIN" },
      ],
      commentPrefix: "#",
    };
    expect(parseCsvColumns(fixture("csv-column-sample.csv"), cfg)).toEqual([
      { entityType: "URL", value: "http://malware.example/a.exe" },
      { entityType: "DOMAIN", value: "malware.example" },
      { entityType: "URL", value: "https://c2.evil.example/gate.php" },
      { entityType: "DOMAIN", value: "c2.evil.example" },
      { entityType: "URL", value: "http://phishing.evil.example/login" },
      { entityType: "DOMAIN", value: "phishing.evil.example" },
    ]);
  });

  it("honors a custom delimiter and quoted fields", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 1, entityType: "DOMAIN" }],
      delimiter: ";",
    };
    expect(parseCsvColumns('a;"quoted.example";c', cfg)).toEqual([
      { entityType: "DOMAIN", value: "quoted.example" },
    ]);
  });

  it("treats empty / comment-only content as a clear (no rows, no error)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "url", entityType: "URL" }],
      commentPrefix: "#",
    };
    expect(parseCsvColumns("", cfg)).toEqual([]);
    expect(parseCsvColumns("# only a comment\n", cfg)).toEqual([]);
  });

  it("throws on a missing header name (never a silent 0 rows)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "nope", entityType: "URL" }],
      commentPrefix: "#",
    };
    expect(() =>
      parseCsvColumns(fixture("csv-column-sample.csv"), cfg),
    ).toThrow(FeedParseError);
  });

  it("throws on an out-of-range index", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 9, entityType: "IP" }],
    };
    expect(() => parseCsvColumns("1.2.3.4,foo", cfg)).toThrow(FeedParseError);
  });

  it("throws via parseFeedContent when csv-column config is missing", () => {
    expect(() => parseFeedContent("csv-column", "URL", "a,b\n")).toThrow(
      FeedParseError,
    );
  });
});

describe("parseFeedContent generic kinds → normalized rows", () => {
  it("normalizes generic-list DOMAIN rows", () => {
    expect(
      parseFeedContent(
        "generic-list",
        "DOMAIN",
        fixture("generic-list-domains.txt"),
      ),
    ).toEqual([
      { matchValue: "bad-domain.example" },
      { matchValue: "c2.evil.example" },
      { matchValue: "phishing.evil.example" },
    ]);
  });

  it("threads refang config through dispatch into normalized rows", () => {
    const rows = parseFeedContent(
      "generic-list",
      "URL",
      fixture("generic-list-defanged.txt"),
      { kind: "generic-list", refang: true },
    );
    // Refang is applied before normalization, so the defanged fixture yields
    // canonical URLs (and the `admin@evil.example` line, not a URL, is dropped
    // by URL normalization).
    expect(rows).toEqual([
      { matchValue: "http://malware.example/a.exe" },
      { matchValue: "https://c2.evil.example/gate.php" },
    ]);
  });

  it("normalizes csv-column rows and stamps each row's entity type", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [
        { name: "url", entityType: "URL" },
        { name: "host", entityType: "DOMAIN" },
      ],
      commentPrefix: "#",
    };
    const rows = parseFeedContent(
      "csv-column",
      "URL",
      fixture("csv-column-sample.csv"),
      cfg,
    );
    // Grouped by entity type (URL rows then DOMAIN rows), each row carrying
    // its column's entityType so a multi-type CSV lands under one source.
    expect(rows).toEqual([
      { matchValue: "http://malware.example/a.exe", entityType: "URL" },
      { matchValue: "https://c2.evil.example/gate.php", entityType: "URL" },
      { matchValue: "http://phishing.evil.example/login", entityType: "URL" },
      { matchValue: "malware.example", entityType: "DOMAIN" },
      { matchValue: "c2.evil.example", entityType: "DOMAIN" },
      { matchValue: "phishing.evil.example", entityType: "DOMAIN" },
    ]);
  });
});

describe("feed normalization → snapshot rows", () => {
  it("normalizes exact IPs and drops invalid entries", () => {
    const { rows, skipped } = normalizeExactValues("IP", [
      "203.0.113.10",
      "not-an-ip",
    ]);
    expect(rows).toEqual([{ matchValue: "203.0.113.10" }]);
    expect(skipped).toBe(1);
  });

  it("canonicalizes URLs at import (default port stripped)", () => {
    const { rows } = normalizeExactValues("URL", [
      "http://Malware.Example:80/Payload.EXE",
    ]);
    expect(rows[0].matchValue).toBe("http://malware.example/Payload.EXE");
  });

  it("de-duplicates and validates CIDRs", () => {
    const { rows, skipped } = normalizeCidrs([
      "192.0.2.0/24",
      "192.0.2.0/24",
      "garbage",
    ]);
    expect(rows).toEqual([{ cidr: "192.0.2.0/24" }]);
    expect(skipped).toBe(1);
  });

  it("rejects malformed CIDRs that the loose shape would have passed", () => {
    // Each of these matches `[0-9a-fA-F:.]+/\d+` but is not a valid
    // PostgreSQL `cidr`, so they must be skipped (not forwarded to a
    // `$N::cidr` insert that 500s mid-import).
    const { rows, skipped } = normalizeCidrs([
      "999.999.999.999/24", // octet out of range
      "203.0.113.0/33", // IPv4 prefix out of range
      "2001:db8::/129", // IPv6 prefix out of range
    ]);
    expect(rows).toEqual([]);
    expect(skipped).toBe(3);
  });

  it("canonicalizes a CIDR with host bits set to its network address", () => {
    const { rows, skipped } = normalizeCidrs(["203.0.113.1/24"]);
    expect(rows).toEqual([{ cidr: "203.0.113.0/24" }]);
    expect(skipped).toBe(0);
  });
});

describe("hasFeedDataLines", () => {
  it("is false for empty / comment-only content", () => {
    expect(hasFeedDataLines("")).toBe(false);
    expect(hasFeedDataLines("\n\n  \n")).toBe(false);
    expect(hasFeedDataLines("# a comment\n; another\n")).toBe(false);
  });

  it("is true when there is a non-comment data line", () => {
    expect(hasFeedDataLines("# header\n45.66.230.5\n")).toBe(true);
  });

  it("consumes a configured comment prefix set", () => {
    // `//` is the only comment prefix here, so `;` and `#` lines are data.
    expect(hasFeedDataLines("// c\n; x", ["//"])).toBe(true);
    expect(hasFeedDataLines("// c\n// d", ["//"])).toBe(false);
  });
});

describe("isUnparseableFeedContent", () => {
  it("flags data that parses to zero rows (e.g. an HTML error page)", () => {
    const html = "<html><body>503 Service Unavailable</body></html>";
    expect(isUnparseableFeedContent("ip-blocklist", "IP", html)).toBe(true);
  });

  it("does not flag a genuinely empty / comment-only feed", () => {
    expect(isUnparseableFeedContent("ip-blocklist", "IP", "# none\n")).toBe(
      false,
    );
    expect(isUnparseableFeedContent("ip-blocklist", "IP", "")).toBe(false);
  });

  it("does not flag content that parses to at least one row", () => {
    expect(
      isUnparseableFeedContent("ip-blocklist", "IP", "# h\n45.66.230.5\n"),
    ).toBe(false);
  });

  it("flags csv-column with a missing header name (parse error → unparseable)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "nope", entityType: "URL" }],
      commentPrefix: "#",
    };
    expect(
      isUnparseableFeedContent(
        "csv-column",
        "URL",
        fixture("csv-column-sample.csv"),
        cfg,
      ),
    ).toBe(true);
  });

  it("flags csv-column with an out-of-range index", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 9, entityType: "IP" }],
    };
    expect(
      isUnparseableFeedContent("csv-column", "IP", "1.2.3.4,foo\n", cfg),
    ).toBe(true);
  });

  it("does not flag a header-only csv-column body (legitimately empty)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "url", entityType: "URL" }],
      skipHeader: true,
      commentPrefix: "#",
    };
    // Header row present, no data rows: the header is not a data line, so the
    // source is legitimately cleared rather than flagged unparseable.
    expect(
      isUnparseableFeedContent("csv-column", "URL", "# c\nid,url,host\n", cfg),
    ).toBe(false);
  });

  it("uses the configured comment prefix for the data-line check", () => {
    const cfg: GenericListParseConfig = {
      kind: "generic-list",
      commentPrefixes: ["//"],
    };
    // Under this config `#` is NOT a comment, so `# x` is a data line the
    // generic-list parser keeps but DOMAIN normalization drops → unparseable.
    // (A hardcoded `#` comment check would have wrongly called it empty.)
    expect(
      isUnparseableFeedContent("generic-list", "DOMAIN", "# x\n", cfg),
    ).toBe(true);
    // A genuine `//`-only body stays a legitimate clear.
    expect(
      isUnparseableFeedContent("generic-list", "DOMAIN", "// only\n", cfg),
    ).toBe(false);
  });
});

describe("feed hash", () => {
  it("is deterministic regardless of row order", () => {
    const a = computeFeedHash([{ matchValue: "x" }, { matchValue: "y" }]);
    const b = computeFeedHash([{ matchValue: "y" }, { matchValue: "x" }]);
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    const a = computeFeedHash([{ matchValue: "x" }]);
    const b = computeFeedHash([{ matchValue: "z" }]);
    expect(a).not.toBe(b);
  });

  // RFC 0003 F6 (#594) — context-aware hashing, backward compatible.
  it("leaves a context-less row's hash byte-identical to before F6", () => {
    // Pinned pre-F6 hashes: the existing five context-less feeds must keep
    // their exact feed_hash so F6 causes no spurious re-import / churn.
    expect(computeFeedHash([{ matchValue: "x" }, { matchValue: "y" }])).toBe(
      "9ab9de25768ac172235e119b76362ecddad33878fe9a7792cdddbe47236f9a87",
    );
    expect(computeFeedHash([{ matchValue: "45.66.230.5" }])).toBe(
      "a8294758fdbd63d9b18c264f1949f90b434fee055e506925c94bb0bde6a79012",
    );
  });

  it("ignores an undefined context (same as no context field)", () => {
    expect(computeFeedHash([{ matchValue: "x", context: undefined }])).toBe(
      computeFeedHash([{ matchValue: "x" }]),
    );
  });

  it("changes when a row's context changes", () => {
    const withCtx = computeFeedHash([
      { matchValue: "x", context: { actor: "APT1" } },
    ]);
    const without = computeFeedHash([{ matchValue: "x" }]);
    const otherCtx = computeFeedHash([
      { matchValue: "x", context: { actor: "APT2" } },
    ]);
    expect(withCtx).not.toBe(without);
    expect(withCtx).not.toBe(otherCtx);
  });

  it("treats an undefined-valued context field as absent (matches stored JSON)", () => {
    // The INSERT stores JSON.stringify(context), which drops undefined
    // properties, so {actor:"APT1", campaign:undefined} persists identically
    // to {actor:"APT1"} and must therefore hash identically — otherwise two
    // byte-identical snapshots would look like a context change.
    const withUndef = computeFeedHash([
      { matchValue: "x", context: { actor: "APT1", campaign: undefined } },
    ]);
    const without = computeFeedHash([
      { matchValue: "x", context: { actor: "APT1" } },
    ]);
    expect(withUndef).toBe(without);
  });

  it("treats an all-undefined context as no context (hash unchanged, stays null)", () => {
    // {actor:undefined} serializes to {} and narrows back to no payload, so it
    // must neither change feed_hash nor be folded into the hash entry.
    expect(
      computeFeedHash([{ matchValue: "x", context: { actor: undefined } }]),
    ).toBe(computeFeedHash([{ matchValue: "x" }]));
  });

  it("treats an extra emptied by nested-undefined cleanup as no context", () => {
    // {extra:{a:undefined}} cleans to {extra:{}}, carrying no usable context.
    // It must hash like no context (so the row stores NULL and the existing
    // five feeds keep their feed_hash), not fold a phantom {extra:{}} in.
    expect(
      computeFeedHash([
        { matchValue: "x", context: { extra: { a: undefined } } },
      ]),
    ).toBe(computeFeedHash([{ matchValue: "x" }]));
    // A non-empty extra is still genuine context and does change the hash.
    expect(
      computeFeedHash([
        { matchValue: "x", context: { extra: { tlp: "amber" } } },
      ]),
    ).not.toBe(computeFeedHash([{ matchValue: "x" }]));
  });

  it("hashes the same context identically regardless of key order", () => {
    const a = computeFeedHash([
      {
        matchValue: "x",
        context: {
          actor: "APT1",
          campaign: "Op",
          extra: { a: 1, b: 2 },
        },
      },
    ]);
    const b = computeFeedHash([
      {
        matchValue: "x",
        context: {
          extra: { b: 2, a: 1 },
          campaign: "Op",
          actor: "APT1",
        },
      },
    ]);
    expect(a).toBe(b);
  });
});
