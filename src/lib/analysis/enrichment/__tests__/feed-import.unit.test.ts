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
  parseFreeTextIocs,
  parseGenericList,
  parseIpBlocklist,
  parseSpamhausDrop,
  parseUrlhausCsv,
  parseUrlhausHosts,
  parseUrlhausPayloadsCsv,
  refangIndicator,
  resolveRowHitType,
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

describe("parseCsvColumns row-typed mode (#605, Infoblox)", () => {
  // The Infoblox schema: a per-row `type` column selects the entity type, a
  // `classification` allowlist filters rows, and values are defanged.
  const infobloxConfig: CsvColumnParseConfig = {
    kind: "csv-column",
    typeColumn: {
      value: { name: "indicator" },
      type: { name: "type" },
      typeMap: {
        domain: "DOMAIN",
        ip: "IP",
        ipv4: "IP",
        url: "URL",
        sha256: "HASH",
      },
    },
    rowFilter: {
      column: { name: "classification" },
      allow: ["malicious", "phishing", "malware", "malvertising"],
    },
    refang: true,
    skipHeader: true,
  };

  it("maps each row's type to an entity type (ipv4 → IP), refanging values", () => {
    const text = [
      "type,indicator,classification,detected_date",
      "domain,bad[.]example,malicious,2025-05-20",
      "ipv4,185.222.58[.]0,phishing,2025-12-01",
      "ip,203.0.113[.]7,malware,2024-01-15",
      "url,hxxp://malware[.]example/gate[.]php,malvertising,2025-03-10",
    ].join("\n");
    expect(parseCsvColumns(text, infobloxConfig)).toEqual([
      { entityType: "DOMAIN", value: "bad.example" },
      { entityType: "IP", value: "185.222.58.0" },
      { entityType: "IP", value: "203.0.113.7" },
      { entityType: "URL", value: "http://malware.example/gate.php" },
    ]);
  });

  it("skips rows whose type is not in the map (email, telfhash, drift)", () => {
    const text = [
      "type,indicator,classification,detected_date",
      "email,admin[at]evil[.]example,malicious,2025-02-02",
      "telfhash,t1abcdef,malware,2023-07-14",
      "future-type,whatever[.]example,malicious,2025-01-01",
      "domain,kept[.]example,malicious,2025-01-01",
    ].join("\n");
    // Only the mapped `domain` row survives the type skip.
    expect(parseCsvColumns(text, infobloxConfig)).toEqual([
      { entityType: "DOMAIN", value: "kept.example" },
    ]);
  });

  it("drops rows whose classification is outside the allowlist", () => {
    const text = [
      "type,indicator,classification,detected_date",
      "domain,threat[.]example,malicious,2025-01-01",
      "domain,good[.]example,legitimate,2025-01-01",
      "domain,parked[.]example,other,2025-01-01",
    ].join("\n");
    // `legitimate` / `other` are not threats → dropped; only `malicious` kept.
    expect(parseCsvColumns(text, infobloxConfig)).toEqual([
      { entityType: "DOMAIN", value: "threat.example" },
    ]);
  });

  it("resolves the header on a BOM-prefixed file", () => {
    // The fixture begins with a UTF-8 BOM before `type`; the parser must strip
    // it so the `indexOf("type")` header lookup still resolves.
    expect(fixture("infoblox-bom.csv").charCodeAt(0)).toBe(0xfeff);
    expect(
      parseCsvColumns(fixture("infoblox-bom.csv"), infobloxConfig),
    ).toEqual([
      { entityType: "DOMAIN", value: "vault-viper.example" },
      { entityType: "IP", value: "198.51.100.23" },
    ]);
  });

  it("rejects a config that sets both columns and typeColumn", () => {
    const bad: CsvColumnParseConfig = {
      ...infobloxConfig,
      columns: [{ name: "indicator", entityType: "DOMAIN" }],
    };
    expect(() => parseCsvColumns("type,indicator\n", bad)).toThrow(
      FeedParseError,
    );
  });

  it("throws when the value/type column header is absent", () => {
    const text = "kind,value\ndomain,bad[.]example\n";
    expect(() => parseCsvColumns(text, infobloxConfig)).toThrow(FeedParseError);
  });
});

describe("parseCsvColumns static mode refang (#605)", () => {
  it("refangs extracted values when refang is set", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 0, entityType: "DOMAIN" }],
      refang: true,
    };
    expect(
      parseCsvColumns("evil[.]example,x\nc2(.)bad[.]example,y", cfg),
    ).toEqual([
      { entityType: "DOMAIN", value: "evil.example" },
      { entityType: "DOMAIN", value: "c2.bad.example" },
    ]);
  });
});

describe("parseFreeTextIocs (#603)", () => {
  it("extracts IOCs embedded in a sentence (where generic-list cannot)", () => {
    const prose =
      "The implant beaconed to hxxps://c2[.]evil[.]example/p from " +
      "203[.]0[.]113[.]9 and dropped a file (md5 " +
      "0123456789abcdef0123456789abcdef) hosted on cdn[.]evil[.]example.";
    expect(parseFreeTextIocs(prose)).toEqual([
      { entityType: "URL", value: "https://c2.evil.example/p" },
      { entityType: "HASH", value: "0123456789abcdef0123456789abcdef" },
      { entityType: "IP", value: "203.0.113.9" },
      { entityType: "DOMAIN", value: "cdn.evil.example" },
    ]);
  });

  it("a whole-line generic-list parser would lose those embedded IOCs", () => {
    // The exact gap #603 closes: generic-list keeps the line verbatim, which
    // then fails normalization (it is a sentence, not an indicator).
    const line = "beaconed to c2.evil.example over https";
    expect(parseGenericList(line)).toEqual([line]);
    expect(parseFreeTextIocs(line)).toEqual([
      { entityType: "DOMAIN", value: "c2.evil.example" },
    ]);
  });

  it("keeps a defanged bare .com domain (com is a TLD, not a file extension)", () => {
    // Regression: `com` must not live in the file-extension drop set, or every
    // real-world `.com` IOC in prose would be silently lost.
    const prose = "resolved c2[.]evil[.]com before exfil to 203[.]0[.]113[.]9";
    expect(parseFreeTextIocs(prose)).toEqual([
      { entityType: "IP", value: "203.0.113.9" },
      { entityType: "DOMAIN", value: "c2.evil.com" },
    ]);
  });

  it("still drops a filename-looking token whose tail is a true extension", () => {
    // The filter's purpose survives: `payload.exe` is not read as a DOMAIN.
    expect(parseFreeTextIocs("dropped payload.exe onto disk")).toEqual([]);
  });

  it("normalizes free-text rows through parseFeedContent, stamping entity types", () => {
    const rows = parseFeedContent(
      "free-text",
      "DOMAIN",
      "see 198[.]51[.]100[.]7 and hxxp://bad[.]example/x",
    );
    expect(rows).toEqual([
      { matchValue: "http://bad.example/x", entityType: "URL" },
      { matchValue: "198.51.100.7", entityType: "IP" },
    ]);
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

  it("normalizes the Infoblox fixture: multi-entity, refanged, skips applied", () => {
    const infobloxConfig: CsvColumnParseConfig = {
      kind: "csv-column",
      typeColumn: {
        value: { name: "indicator" },
        type: { name: "type" },
        typeMap: {
          domain: "DOMAIN",
          ip: "IP",
          ipv4: "IP",
          url: "URL",
          sha256: "HASH",
        },
      },
      rowFilter: {
        column: { name: "classification" },
        allow: ["malicious", "phishing", "malware", "malvertising"],
      },
      refang: true,
      skipHeader: true,
    };
    const rows = parseFeedContent(
      "csv-column",
      "DOMAIN",
      fixture("infoblox-threat-intelligence.csv"),
      infobloxConfig,
    );
    // Grouped by first-seen entity type (DOMAIN, IP, URL, HASH). The `email` /
    // `telfhash` rows are type-skipped; the `legitimate` / `other` rows are
    // classification-skipped; defanged values are refanged before normalizing.
    expect(rows).toEqual([
      { matchValue: "4ktv-live.blogspot.example", entityType: "DOMAIN" },
      { matchValue: "185.222.58.0", entityType: "IP" },
      { matchValue: "203.0.113.7", entityType: "IP" },
      { matchValue: "http://malware.example/gate.php", entityType: "URL" },
      {
        matchValue:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        entityType: "HASH",
      },
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

  it("flags a header-only csv-column body whose config is invalid", () => {
    // Only one non-comment line (the header), but the configured header name is
    // absent: the parser must still be invoked so this surfaces as a parse
    // error / unparseable rather than a silent clear (the header subtraction
    // must not short-circuit config validation).
    const missingName: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ name: "missing", entityType: "URL" }],
      commentPrefix: "#",
    };
    expect(
      isUnparseableFeedContent(
        "csv-column",
        "URL",
        "# c\nid,url,host\n",
        missingName,
      ),
    ).toBe(true);
    // Same shape with an out-of-range index under skipHeader: the lone header
    // line cannot satisfy index 5, so it is unparseable, not a clear.
    const badIndex: CsvColumnParseConfig = {
      kind: "csv-column",
      columns: [{ index: 5, entityType: "URL" }],
      skipHeader: true,
    };
    expect(
      isUnparseableFeedContent("csv-column", "URL", "id,url,host\n", badIndex),
    ).toBe(true);
  });

  it("treats a header-only row-typed csv-column body as a legitimate clear (#605)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      typeColumn: {
        value: { name: "indicator" },
        type: { name: "type" },
        typeMap: { domain: "DOMAIN" },
      },
      skipHeader: true,
    };
    // Lone header line, no data rows: the header is consumed, not data, so the
    // source is legitimately cleared rather than flagged unparseable.
    expect(
      isUnparseableFeedContent(
        "csv-column",
        "DOMAIN",
        "type,indicator,classification,detected_date\n",
        cfg,
      ),
    ).toBe(false);
  });

  it("flags a row-typed csv-column body whose header is absent (#605)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      typeColumn: {
        value: { name: "indicator" },
        type: { name: "type" },
        typeMap: { domain: "DOMAIN" },
      },
      skipHeader: true,
    };
    // The configured `type`/`indicator` headers are absent: the parser must be
    // invoked so this surfaces as a parse error / unparseable, not a clear.
    expect(
      isUnparseableFeedContent(
        "csv-column",
        "DOMAIN",
        "kind,value\ndomain,bad.example\n",
        cfg,
      ),
    ).toBe(true);
  });

  it("treats an Infoblox body of only skipped rows as a valid empty import (#605)", () => {
    const cfg: CsvColumnParseConfig = {
      kind: "csv-column",
      typeColumn: {
        value: { name: "indicator" },
        type: { name: "type" },
        typeMap: { domain: "DOMAIN", ip: "IP", ipv4: "IP" },
      },
      rowFilter: {
        column: { name: "classification" },
        allow: ["malicious", "phishing"],
      },
      refang: true,
      skipHeader: true,
    };
    // A header PLUS many data rows that are all intentionally skipped — every
    // row excluded by the classification allowlist (`legitimate`/`other`) and/or
    // an unmapped type (`email`/`telfhash`). The parser correctly yields zero
    // rows; this is a recognized, valid body (an all-`legitimate` upstream file
    // really exists) and must NOT be rejected as unparseable, or manual upload /
    // a future self-fetch would wrongly drop a good source.
    const allSkipped =
      "type,indicator,classification,detected_date\n" +
      "domain,a[.]example,legitimate,2025-05-20\n" +
      "ipv4,185.222.58[.]0,other,2025-12-01\n" +
      "email,abuse@example[.]com,malicious,2024-01-01\n" +
      "telfhash,t1fde0f101c9395f39ecd16430b41041a5,malware,2023-07-14\n";
    expect(
      isUnparseableFeedContent("csv-column", "DOMAIN", allSkipped, cfg),
    ).toBe(false);
    // Sanity: the same parser does emit rows once a row clears both gates, so
    // the "valid empty import" verdict is not masking a broken config.
    const oneKept = `${allSkipped}domain,bad[.]example,malicious,2025-06-01\n`;
    expect(isUnparseableFeedContent("csv-column", "DOMAIN", oneKept, cfg)).toBe(
      false,
    );
    expect(parseCsvColumns(oneKept, cfg)).toEqual([
      { entityType: "DOMAIN", value: "bad.example" },
    ]);
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

  // RFC 0003 F4 (#603) — per-row hit-type / classification override hashing.
  it("leaves a row without overrides byte-identical (existing five feeds)", () => {
    // A row carrying only the new optional fields as absent must hash exactly
    // as a bare row — the pinned pre-#603 hashes still hold.
    expect(computeFeedHash([{ matchValue: "x" }, { matchValue: "y" }])).toBe(
      "9ab9de25768ac172235e119b76362ecddad33878fe9a7792cdddbe47236f9a87",
    );
  });

  it("changes the hash when a row carries a hit-type override", () => {
    const base = computeFeedHash([{ matchValue: "x" }]);
    const overridden = computeFeedHash([
      { matchValue: "x", hitType: "soft_reputation" },
    ]);
    expect(overridden).not.toBe(base);
  });

  it("folds the CIB guard's forced soft_reputation into the hash", () => {
    // A deterministicAllowed:false row hashes like an explicit soft_reputation
    // override (the guard forces that effective hit type), and differs from a
    // default-using row — so flipping the guard re-imports, never silently
    // skipped.
    const guarded = computeFeedHash([
      { matchValue: "x", deterministicAllowed: false },
    ]);
    const explicit = computeFeedHash([
      { matchValue: "x", hitType: "soft_reputation" },
    ]);
    const base = computeFeedHash([{ matchValue: "x" }]);
    expect(guarded).toBe(explicit);
    expect(guarded).not.toBe(base);
  });

  it("changes the hash when a row carries a classification override", () => {
    expect(
      computeFeedHash([{ matchValue: "x", classification: "cib" }]),
    ).not.toBe(computeFeedHash([{ matchValue: "x" }]));
  });
});

describe("resolveRowHitType (#603 central CIB guard)", () => {
  it("forces soft_reputation when deterministicAllowed is false", () => {
    expect(
      resolveRowHitType(
        { matchValue: "x", deterministicAllowed: false },
        "deterministic_ioc",
      ),
    ).toBe("soft_reputation");
    // The guard overrides even an explicit per-row deterministic_ioc — it can
    // never be circumvented by a row's own self-declaration.
    expect(
      resolveRowHitType(
        {
          matchValue: "x",
          hitType: "deterministic_ioc",
          deterministicAllowed: false,
        },
        "deterministic_ioc",
      ),
    ).toBe("soft_reputation");
  });

  it("uses the row override, else the snapshot default", () => {
    expect(
      resolveRowHitType(
        { matchValue: "x", hitType: "soft_reputation" },
        "deterministic_ioc",
      ),
    ).toBe("soft_reputation");
    expect(resolveRowHitType({ matchValue: "x" }, "deterministic_ioc")).toBe(
      "deterministic_ioc",
    );
  });
});
