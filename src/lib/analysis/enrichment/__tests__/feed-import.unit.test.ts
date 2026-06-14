// RFC 0003 P1a (#361) — feed parser + normalization unit tests (pure, no
// DB). The DB import path (`importFeedSnapshot`) is covered by the worker
// db tests.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeFeedHash,
  hasFeedDataLines,
  isUnparseableFeedContent,
  normalizeCidrs,
  normalizeExactValues,
  parseIpBlocklist,
  parseSpamhausDrop,
  parseUrlhausCsv,
  parseUrlhausHosts,
  parseUrlhausPayloadsCsv,
} from "../feed-import";

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
