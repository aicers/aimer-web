// RFC 0003 P1a (#361) — indicator extraction from a stored, already-
// redacted `story_member.event` JSONB. Covers raw external indicators,
// tokenized customer-asset IP recovery, dedupe, and the redactionToken
// identity reference.

import { describe, expect, it } from "vitest";
import type { EntityKind } from "@/lib/redaction/types";
import { extractIndicators, type RecoverToken } from "../indicator-extraction";

const noRecover: RecoverToken = () => undefined;

function byType(
  results: ReturnType<typeof extractIndicators>,
  type: string,
): string[] {
  return results
    .filter((r) => r.indicator.entityType === type)
    .map((r) => r.indicator.value)
    .sort();
}

describe("indicator extraction — raw external indicators", () => {
  it("extracts a raw external IP read directly from member text", () => {
    // A genuine public-unicast IP (RFC 5737 doc ranges are classified
    // `reserved` → non-public, so they would never be floor-eligible).
    const event = { resp_addr: "45.66.230.5", note: "outbound" };
    const out = extractIndicators(event, noRecover);
    expect(byType(out, "IP")).toEqual(["45.66.230.5"]);
    // External raw indicators use the value itself as the evidence token.
    const ip = out.find((r) => r.indicator.entityType === "IP");
    expect(ip?.redactionToken).toBe("45.66.230.5");
    expect(ip?.indicator.isPublic).toBe(true);
  });

  it("extracts URL, hash, and domain from nested strings", () => {
    const event = {
      http: { uri: "http://malware.example/payload.exe" },
      file: { sha256: "A".repeat(64) },
      dns: { query: "c2.example.test" },
    };
    const out = extractIndicators(event, noRecover);
    expect(byType(out, "URL")).toEqual(["http://malware.example/payload.exe"]);
    expect(byType(out, "HASH")).toEqual(["a".repeat(64)]);
    // The URL's host is captured by the URL indicator's derived values, not
    // re-extracted as a bare domain. The standalone DNS query is a domain.
    expect(byType(out, "DOMAIN")).toEqual(["c2.example.test"]);
  });

  it("filters non-domain dotted tokens (no public suffix)", () => {
    const event = { file: "report.tmp", version: "1.2.3" };
    const out = extractIndicators(event, noRecover);
    expect(byType(out, "DOMAIN")).toEqual([]);
  });

  it("de-duplicates the same indicator seen twice", () => {
    const event = { a: "203.0.113.10", b: "203.0.113.10" };
    const out = extractIndicators(event, noRecover);
    expect(byType(out, "IP")).toEqual(["203.0.113.10"]);
  });
});

describe("indicator extraction — tokenized customer-asset recovery", () => {
  it("recovers a tokenized customer-asset IP via the redaction map", () => {
    const event = { orig_addr: "<<REDACTED_IP_001>>" };
    const map: Record<string, { kind: EntityKind; value: string }> = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.1.2.3" },
    };
    const out = extractIndicators(event, (t) => map[t]);
    expect(byType(out, "IP")).toEqual(["10.1.2.3"]);
    const ip = out.find((r) => r.indicator.entityType === "IP");
    // The token is the evidence reference for a recovered value.
    expect(ip?.redactionToken).toBe("<<REDACTED_IP_001>>");
    // A private IP is non-public → never floor-eligible downstream.
    expect(ip?.indicator.isPublic).toBe(false);
    expect(ip?.indicator.neverOffHost).toBe(true);
  });

  it("skips email/mac tokens (not IOC entity types)", () => {
    const event = {
      mail: "<<REDACTED_EMAIL_001>>",
      nic: "<<REDACTED_MAC_001>>",
    };
    const map: Record<string, { kind: EntityKind; value: string }> = {
      "<<REDACTED_EMAIL_001>>": { kind: "email", value: "a@b.example" },
      "<<REDACTED_MAC_001>>": { kind: "mac", value: "aa:bb:cc:dd:ee:ff" },
    };
    const out = extractIndicators(event, (t) => map[t]);
    expect(out).toHaveLength(0);
  });

  it("extracts a raw external IP alongside a tokenized customer IP", () => {
    const event = {
      orig_addr: "<<REDACTED_IP_001>>",
      resp_addr: "45.66.230.5",
    };
    const map: Record<string, { kind: EntityKind; value: string }> = {
      "<<REDACTED_IP_001>>": { kind: "ip", value: "10.1.2.3" },
    };
    const out = extractIndicators(event, (t) => map[t]);
    expect(byType(out, "IP")).toEqual(["10.1.2.3", "45.66.230.5"]);
  });
});
