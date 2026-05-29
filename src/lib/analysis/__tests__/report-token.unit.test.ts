import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildRangeSet } from "../../redaction/ranges";
import type { RangeSet } from "../../redaction/types";
import {
  buildReportTokenMap,
  scanReportAnalysisForLeaks,
} from "../report-token";

const EMPTY_RANGES: RangeSet = buildRangeSet([]);

describe("buildReportTokenMap", () => {
  it("folds story-scope (E{i}) and event-scope tokens into one R{j} namespace", () => {
    const out = buildReportTokenMap(
      [
        // story leaf 0 — story-scope tokens across two members.
        "Member <<REDACTED_IP_E1_001>> reached <<REDACTED_IP_E2_001>>.",
      ],
      [
        // event leaf 0 — bare event-scope tokens.
        "Host <<REDACTED_IP_001>> mailed <<REDACTED_EMAIL_004>>.",
      ],
    );

    // Story leaf is j=1; its two distinct source tokens renumber to a
    // fresh per-leaf sequence so the E1/E2 collision on NNN=001 is gone.
    expect(out.rewrittenStoryTexts[0]).toBe(
      "Member <<REDACTED_IP_R1_001>> reached <<REDACTED_IP_R1_002>>.",
    );
    // Event leaf is j=2 (stories first, then events).
    expect(out.rewrittenEventTexts[0]).toBe(
      "Host <<REDACTED_IP_R2_001>> mailed <<REDACTED_EMAIL_R2_002>>.",
    );

    expect(out.refs).toHaveLength(2);
    expect(out.refs[0]).toMatchObject({ index: 1, kind: "story" });
    expect(out.refs[0].tokens).toEqual([
      {
        reportToken: "<<REDACTED_IP_R1_001>>",
        sourceToken: "<<REDACTED_IP_E1_001>>",
      },
      {
        reportToken: "<<REDACTED_IP_R1_002>>",
        sourceToken: "<<REDACTED_IP_E2_001>>",
      },
    ]);
    expect(out.refs[1]).toMatchObject({ index: 2, kind: "event" });
    expect(out.refs[1].tokens).toEqual([
      {
        reportToken: "<<REDACTED_IP_R2_001>>",
        sourceToken: "<<REDACTED_IP_001>>",
      },
      {
        reportToken: "<<REDACTED_EMAIL_R2_002>>",
        sourceToken: "<<REDACTED_EMAIL_004>>",
      },
    ]);

    expect(out.allowedTokens).toEqual(
      new Set([
        "<<REDACTED_IP_R1_001>>",
        "<<REDACTED_IP_R1_002>>",
        "<<REDACTED_IP_R2_001>>",
        "<<REDACTED_EMAIL_R2_002>>",
      ]),
    );
  });

  it("maps a recurring source token to one stable report token per leaf", () => {
    const out = buildReportTokenMap(
      ["<<REDACTED_IP_E1_009>> twice: <<REDACTED_IP_E1_009>>"],
      [],
    );
    expect(out.rewrittenStoryTexts[0]).toBe(
      "<<REDACTED_IP_R1_001>> twice: <<REDACTED_IP_R1_001>>",
    );
    expect(out.refs[0].tokens).toHaveLength(1);
  });

  it("keeps identical source-token numbers distinct across leaves", () => {
    const out = buildReportTokenMap(
      ["<<REDACTED_IP_E1_001>>"],
      ["<<REDACTED_IP_001>>"],
    );
    // Different plaintext entities — must not collapse to one token.
    expect(out.rewrittenStoryTexts[0]).toBe("<<REDACTED_IP_R1_001>>");
    expect(out.rewrittenEventTexts[0]).toBe("<<REDACTED_IP_R2_001>>");
  });

  it("handles leaves with no tokens (baseline-style narrative)", () => {
    const out = buildReportTokenMap(["No redacted entities here."], []);
    expect(out.rewrittenStoryTexts[0]).toBe("No redacted entities here.");
    expect(out.refs[0].tokens).toEqual([]);
    expect(out.allowedTokens.size).toBe(0);
  });
});

describe("scanReportAnalysisForLeaks", () => {
  const built = buildReportTokenMap(
    ["<<REDACTED_IP_E1_001>>"],
    ["<<REDACTED_EMAIL_004>>"],
  );

  it("passes a narrative that only echoes allowed report tokens", () => {
    const text =
      "The actor at <<REDACTED_IP_R1_001>> phished <<REDACTED_EMAIL_R2_001>>.";
    const res = scanReportAnalysisForLeaks(text, built.refs, EMPTY_RANGES);
    expect(res.hasLeak).toBe(false);
  });

  it("flags an unmapped report token (fabricated leaf or number)", () => {
    const res = scanReportAnalysisForLeaks(
      "see <<REDACTED_IP_R9_001>>",
      built.refs,
      EMPTY_RANGES,
    );
    expect(res.hasLeak).toBe(true);
    expect(res.leaks[0]).toMatchObject({
      kind: "unmapped_report_token",
      match: "<<REDACTED_IP_R9_001>>",
      index: 9,
    });
  });

  it("flags residual lower-scope tokens the LLM could not have read", () => {
    const story = scanReportAnalysisForLeaks(
      "leftover <<REDACTED_IP_E1_001>>",
      built.refs,
      EMPTY_RANGES,
    );
    expect(story.leaks.some((l) => l.kind === "residual_story_token")).toBe(
      true,
    );
    const event = scanReportAnalysisForLeaks(
      "leftover <<REDACTED_IP_001>>",
      built.refs,
      EMPTY_RANGES,
    );
    expect(event.leaks.some((l) => l.kind === "residual_event_token")).toBe(
      true,
    );
  });

  it("flags always-redacted plaintext PII (email, MAC)", () => {
    const res = scanReportAnalysisForLeaks(
      "contact alice@example.com via aa:bb:cc:dd:ee:ff",
      built.refs,
      EMPTY_RANGES,
    );
    const kinds = res.leaks.map((l) => l.kind);
    expect(kinds.filter((k) => k === "plaintext_pii").length).toBe(2);
  });

  it("flags a private IP literal but not a benign timestamp", () => {
    const res = scanReportAnalysisForLeaks(
      "host 10.0.0.5 logged at 09:30:00",
      built.refs,
      EMPTY_RANGES,
    );
    expect(res.leaks.filter((l) => l.kind === "plaintext_pii")).toHaveLength(1);
    expect(res.leaks[0].match).toBe("10.0.0.5");
  });
});
