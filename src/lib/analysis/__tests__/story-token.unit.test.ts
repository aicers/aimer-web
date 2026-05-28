import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildStoryTokenMap, scanStoryAnalysisForLeaks } from "../story-token";

describe("buildStoryTokenMap", () => {
  it("rewrites event-scope tokens to story-scope with the member index", () => {
    const out = buildStoryTokenMap([
      {
        aiceId: "aice-1",
        eventKey: "1001",
        event: { ip: "<<REDACTED_IP_001>>" },
      },
      {
        aiceId: "aice-2",
        eventKey: "2002",
        event: { ip: "<<REDACTED_IP_001>>", mac: "<<REDACTED_MAC_007>>" },
      },
    ]);
    expect(out.rewrittenMembers[0].event).toEqual({
      ip: "<<REDACTED_IP_E0_001>>",
    });
    expect(out.rewrittenMembers[1].event).toEqual({
      ip: "<<REDACTED_IP_E1_001>>",
      mac: "<<REDACTED_MAC_E1_007>>",
    });
    expect(out.refs).toEqual([
      { index: 0, aiceId: "aice-1", eventKey: "1001" },
      { index: 1, aiceId: "aice-2", eventKey: "2002" },
    ]);
  });

  it("returns an empty refs array for zero members", () => {
    expect(buildStoryTokenMap([])).toEqual({ rewrittenMembers: [], refs: [] });
  });
});

describe("scanStoryAnalysisForLeaks", () => {
  const refs = [
    { index: 0, aiceId: "aice-1", eventKey: "1001" },
    { index: 1, aiceId: "aice-2", eventKey: "2002" },
  ];

  it("returns no leaks when only mapped story tokens appear", () => {
    const r = scanStoryAnalysisForLeaks(
      "Saw <<REDACTED_IP_E0_001>> talking to <<REDACTED_IP_E1_004>>.",
      refs,
    );
    expect(r.hasLeak).toBe(false);
    expect(r.leaks).toEqual([]);
  });

  it("flags unmapped member indices as hallucinations", () => {
    const r = scanStoryAnalysisForLeaks(
      "Suspicious traffic from <<REDACTED_IP_E9_007>>.",
      refs,
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks[0]).toMatchObject({
      kind: "unmapped_story_token",
      index: 9,
    });
  });

  it("flags residual event-scope tokens (the LLM cannot have read one)", () => {
    const r = scanStoryAnalysisForLeaks(
      "Event-scope leak: <<REDACTED_IP_001>>.",
      refs,
    );
    expect(r.hasLeak).toBe(true);
    expect(r.leaks.some((l) => l.kind === "residual_event_token")).toBe(true);
  });

  it("flags plaintext IPv4 / email / MAC PII", () => {
    const r = scanStoryAnalysisForLeaks(
      "User alice@example.com from 10.0.0.5 (mac 00:11:22:33:44:55).",
      refs,
    );
    expect(r.hasLeak).toBe(true);
    const kinds = r.leaks.map((l) => l.kind);
    expect(kinds).toContain("plaintext_pii");
  });
});
