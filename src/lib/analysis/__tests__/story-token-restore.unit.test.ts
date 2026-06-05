import { describe, expect, it } from "vitest";
import type { RedactionMap } from "@/lib/redaction";
import { restoreStoryAnalysisTokens } from "../story-token-restore";

function mkMap(entries: Record<string, string>): RedactionMap {
  const map: RedactionMap = {};
  for (const [token, value] of Object.entries(entries)) {
    map[token] = { value, kind: "ip" };
  }
  return map;
}

describe("restoreStoryAnalysisTokens", () => {
  it("substitutes story-scope tokens via the per-index map", () => {
    const maps = new Map<number, RedactionMap>([
      [0, mkMap({ "<<REDACTED_IP_001>>": "10.0.0.1" })],
      [1, mkMap({ "<<REDACTED_IP_001>>": "192.168.1.1" })],
    ]);
    const text =
      "Source <<REDACTED_IP_E0_001>> talked to <<REDACTED_IP_E1_001>>.";
    expect(restoreStoryAnalysisTokens(text, maps)).toBe(
      "Source 10.0.0.1 talked to 192.168.1.1.",
    );
  });

  it("passes through tokens whose index has no map", () => {
    const maps = new Map<number, RedactionMap>();
    const text = "Saw <<REDACTED_IP_E7_999>>.";
    expect(restoreStoryAnalysisTokens(text, maps)).toBe(text);
  });

  it("passes through tokens whose token number has no entry", () => {
    const maps = new Map<number, RedactionMap>([
      [0, mkMap({ "<<REDACTED_IP_001>>": "10.0.0.1" })],
    ]);
    const text = "Unknown <<REDACTED_IP_E0_999>> token.";
    expect(restoreStoryAnalysisTokens(text, maps)).toBe(text);
  });

  it("handles multiple kinds in the same narrative", () => {
    const maps = new Map<number, RedactionMap>([
      [
        0,
        {
          "<<REDACTED_IP_001>>": { value: "10.0.0.1", kind: "ip" },
          "<<REDACTED_EMAIL_001>>": { value: "u@example.com", kind: "email" },
        },
      ],
    ]);
    const text = "From <<REDACTED_IP_E0_001>> to <<REDACTED_EMAIL_E0_001>>.";
    expect(restoreStoryAnalysisTokens(text, maps)).toBe(
      "From 10.0.0.1 to u@example.com.",
    );
  });

  it("restores story-scope DOMAIN tokens (RFC 0001 Amendment A.2)", () => {
    const maps = new Map<number, RedactionMap>([
      [
        1,
        {
          "<<REDACTED_DOMAIN_001>>": {
            value: "vpn.customer.example",
            kind: "domain",
          },
        },
      ],
    ]);
    const text = "Beacon to <<REDACTED_DOMAIN_E1_001>>.";
    expect(restoreStoryAnalysisTokens(text, maps)).toBe(
      "Beacon to vpn.customer.example.",
    );
  });
});
