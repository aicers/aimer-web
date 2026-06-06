// RFC 0003 C1 (#440) — fact-scope `F{k}` token rename + restore.

import { describe, expect, it } from "vitest";
import type { RedactionMap } from "@/lib/redaction";
import { buildFactTokenMap, restoreStoryFactTokens } from "../fact-token";

describe("buildFactTokenMap — F{k} rename", () => {
  it("renames a customer-asset fact's self-scoped token to fact-scope F{k}", () => {
    const { rewrittenFacts, refs, allowedTokens } = buildFactTokenMap([
      { factId: "10", text: "<<REDACTED_IP_001>> is listed by abuse.ch/feodo" },
    ]);
    expect(rewrittenFacts[0]).toBe(
      "<<REDACTED_IP_F1_001>> is listed by abuse.ch/feodo",
    );
    expect(refs).toEqual([{ index: 1, factId: "10" }]);
    expect(allowedTokens.has("<<REDACTED_IP_F1_001>>")).toBe(true);
  });

  it("indexes k per fact, so the same self-scoped number maps distinctly", () => {
    const { rewrittenFacts, refs } = buildFactTokenMap([
      { factId: "10", text: "host <<REDACTED_DOMAIN_001>> seen" },
      { factId: "11", text: "host <<REDACTED_DOMAIN_001>> seen" },
    ]);
    expect(rewrittenFacts[0]).toBe("host <<REDACTED_DOMAIN_F1_001>> seen");
    expect(rewrittenFacts[1]).toBe("host <<REDACTED_DOMAIN_F2_001>> seen");
    expect(refs).toEqual([
      { index: 1, factId: "10" },
      { index: 2, factId: "11" },
    ]);
  });

  it("leaves an external (token-free) fact raw, but still assigns it a k", () => {
    const { rewrittenFacts, refs, allowedTokens } = buildFactTokenMap([
      { factId: "20", text: "45.66.230.5 is listed by abuse.ch/feodo as c2" },
    ]);
    // No re-redaction: external indicator text is untouched.
    expect(rewrittenFacts[0]).toBe(
      "45.66.230.5 is listed by abuse.ch/feodo as c2",
    );
    expect(refs).toEqual([{ index: 1, factId: "20" }]);
    expect(allowedTokens.size).toBe(0);
  });

  it("renames DOMAIN tokens (the kind shipped by #434)", () => {
    const { rewrittenFacts, allowedTokens } = buildFactTokenMap([
      { factId: "30", text: "<<REDACTED_DOMAIN_002>> resolves internally" },
    ]);
    expect(rewrittenFacts[0]).toBe(
      "<<REDACTED_DOMAIN_F1_002>> resolves internally",
    );
    expect(allowedTokens.has("<<REDACTED_DOMAIN_F1_002>>")).toBe(true);
  });

  it("returns empty results for no facts", () => {
    const { rewrittenFacts, refs, allowedTokens } = buildFactTokenMap([]);
    expect(rewrittenFacts).toEqual([]);
    expect(refs).toEqual([]);
    expect(allowedTokens.size).toBe(0);
  });
});

describe("restoreStoryFactTokens — F{k} render demap", () => {
  const mapsByIndex = new Map<number, RedactionMap>([
    [1, { "<<REDACTED_IP_001>>": { kind: "ip", value: "198.51.100.7" } }],
    [
      2,
      {
        "<<REDACTED_DOMAIN_001>>": { kind: "domain", value: "intranet.corp" },
      },
    ],
  ]);

  it("resolves F{k} back to the customer-asset plaintext via the keyed map", () => {
    const out = restoreStoryFactTokens(
      "saw <<REDACTED_IP_F1_001>> and <<REDACTED_DOMAIN_F2_001>>",
      mapsByIndex,
    );
    expect(out).toBe("saw 198.51.100.7 and intranet.corp");
  });

  it("passes through a token whose fact index has no map (defensive)", () => {
    const out = restoreStoryFactTokens(
      "missing <<REDACTED_IP_F9_001>>",
      mapsByIndex,
    );
    expect(out).toBe("missing <<REDACTED_IP_F9_001>>");
  });

  it("passes through a token whose self-scoped number is absent from the map", () => {
    const out = restoreStoryFactTokens(
      "absent <<REDACTED_IP_F1_999>>",
      mapsByIndex,
    );
    expect(out).toBe("absent <<REDACTED_IP_F1_999>>");
  });

  it("leaves non-fact text untouched", () => {
    expect(restoreStoryFactTokens("plain text", mapsByIndex)).toBe(
      "plain text",
    );
  });
});
