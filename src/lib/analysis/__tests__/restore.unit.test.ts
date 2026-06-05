import { describe, expect, it } from "vitest";
import { restoreRedactedTokens } from "../restore";

describe("restoreRedactedTokens", () => {
  it("substitutes a token back to its original value", () => {
    const map = {
      "<<REDACTED_IP_001>>": { kind: "ip" as const, value: "10.0.0.1" },
    };
    expect(restoreRedactedTokens("attacker <<REDACTED_IP_001>>", map)).toBe(
      "attacker 10.0.0.1",
    );
  });

  it("passes <<UNVERIFIED_*>> markers through unchanged (not restored)", () => {
    // No <<UNVERIFIED_*>> entry exists in the redaction map — by
    // design. The result page renders these with a distinct visual
    // treatment; the loader must not collapse them to their token
    // text or to anything else.
    const map = {};
    const text = "hallucinated <<UNVERIFIED_IP_001>>";
    expect(restoreRedactedTokens(text, map)).toBe(text);
  });

  it("passes a token through unchanged when no map entry exists (defensive)", () => {
    // Unreachable in correct code (engine always writes the entry
    // alongside the token) but the loader chooses safe pass-through
    // over crashing the page.
    const map = {};
    expect(restoreRedactedTokens("<<REDACTED_EMAIL_007>>", map)).toBe(
      "<<REDACTED_EMAIL_007>>",
    );
  });

  it("substitutes multiple tokens of different kinds in one pass", () => {
    const map = {
      "<<REDACTED_IP_001>>": { kind: "ip" as const, value: "203.0.113.5" },
      "<<REDACTED_EMAIL_001>>": {
        kind: "email" as const,
        value: "a@example.com",
      },
    };
    const text = "from <<REDACTED_IP_001>> to <<REDACTED_EMAIL_001>>";
    expect(restoreRedactedTokens(text, map)).toBe(
      "from 203.0.113.5 to a@example.com",
    );
  });

  it("restores DOMAIN tokens (RFC 0001 Amendment A.2)", () => {
    const map = {
      "<<REDACTED_DOMAIN_001>>": {
        kind: "domain" as const,
        value: "vpn.customer.example",
      },
    };
    expect(restoreRedactedTokens("reached <<REDACTED_DOMAIN_001>>", map)).toBe(
      "reached vpn.customer.example",
    );
  });
});
