// RFC 0003 P1a (#361) — feed parser + normalization unit tests (pure, no
// DB). The DB import path (`importFeedSnapshot`) is covered by the worker
// db tests.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeFeedHash,
  normalizeCidrs,
  normalizeExactValues,
  parseIpBlocklist,
  parseSpamhausDrop,
  parseUrlhausCsv,
  parseUrlhausHosts,
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
});
