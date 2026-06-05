import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildOwnedDomainSet } from "../../redaction/domains";
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
        {
          analysis:
            "Member <<REDACTED_IP_E1_001>> reached <<REDACTED_IP_E2_001>>.",
        },
      ],
      [
        // event leaf 0 — bare event-scope tokens.
        { analysis: "Host <<REDACTED_IP_001>> mailed <<REDACTED_EMAIL_004>>." },
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

  it("folds DOMAIN tokens into the report namespace (RFC 0001 Amendment A.2)", () => {
    const out = buildReportTokenMap(
      [{ analysis: "Beacon to <<REDACTED_DOMAIN_E1_001>>." }],
      [{ analysis: "DNS for <<REDACTED_DOMAIN_002>>." }],
    );
    expect(out.rewrittenStoryTexts[0]).toBe(
      "Beacon to <<REDACTED_DOMAIN_R1_001>>.",
    );
    expect(out.rewrittenEventTexts[0]).toBe(
      "DNS for <<REDACTED_DOMAIN_R2_001>>.",
    );
    expect(out.refs[0].tokens).toEqual([
      {
        reportToken: "<<REDACTED_DOMAIN_R1_001>>",
        sourceToken: "<<REDACTED_DOMAIN_E1_001>>",
      },
    ]);
    expect(out.refs[1].tokens).toEqual([
      {
        reportToken: "<<REDACTED_DOMAIN_R2_001>>",
        sourceToken: "<<REDACTED_DOMAIN_002>>",
      },
    ]);
  });

  it("maps a recurring source token to one stable report token per leaf", () => {
    const out = buildReportTokenMap(
      [{ analysis: "<<REDACTED_IP_E1_009>> twice: <<REDACTED_IP_E1_009>>" }],
      [],
    );
    expect(out.rewrittenStoryTexts[0]).toBe(
      "<<REDACTED_IP_R1_001>> twice: <<REDACTED_IP_R1_001>>",
    );
    expect(out.refs[0].tokens).toHaveLength(1);
  });

  it("keeps identical source-token numbers distinct across leaves", () => {
    const out = buildReportTokenMap(
      [{ analysis: "<<REDACTED_IP_E1_001>>" }],
      [{ analysis: "<<REDACTED_IP_001>>" }],
    );
    // Different plaintext entities — must not collapse to one token.
    expect(out.rewrittenStoryTexts[0]).toBe("<<REDACTED_IP_R1_001>>");
    expect(out.rewrittenEventTexts[0]).toBe("<<REDACTED_IP_R2_001>>");
  });

  it("handles leaves with no tokens (baseline-style narrative)", () => {
    const out = buildReportTokenMap(
      [{ analysis: "No redacted entities here." }],
      [],
    );
    expect(out.rewrittenStoryTexts[0]).toBe("No redacted entities here.");
    expect(out.refs[0].tokens).toEqual([]);
    expect(out.allowedTokens.size).toBe(0);
  });

  it("rewrites factor fields through the same per-leaf token map", () => {
    const out = buildReportTokenMap(
      [
        {
          // A scope token shared between the narrative and a factor folds
          // to the SAME report token; a factor-only token mints a fresh one.
          analysis: "Host <<REDACTED_IP_E1_001>> beaconed out.",
          severityFactors: ["lateral movement from <<REDACTED_IP_E1_001>>"],
          likelihoodFactors: ["exfil to <<REDACTED_IP_E2_007>>"],
        },
      ],
      [],
    );
    expect(out.rewrittenStoryTexts[0]).toBe(
      "Host <<REDACTED_IP_R1_001>> beaconed out.",
    );
    expect(out.rewrittenStoryFactors[0].severityFactors).toEqual([
      "lateral movement from <<REDACTED_IP_R1_001>>",
    ]);
    expect(out.rewrittenStoryFactors[0].likelihoodFactors).toEqual([
      "exfil to <<REDACTED_IP_R1_002>>",
    ]);
    // No lower-scope (E{i}) token survives in any field sent to the prompt.
    const allFields = [
      out.rewrittenStoryTexts[0],
      ...out.rewrittenStoryFactors[0].severityFactors,
      ...out.rewrittenStoryFactors[0].likelihoodFactors,
    ].join(" ");
    expect(allFields).not.toMatch(/_E\d+_/);
  });

  it("recovers a factor-only token only when factors are replayed (loader demap invariant)", () => {
    // Build the way the worker does: analysis + factors. The factor-only
    // entity mints R1_002.
    const buildLeaf = {
      analysis: "Host <<REDACTED_IP_E1_001>> beaconed out.",
      likelihoodFactors: ["exfil to <<REDACTED_IP_E2_007>>"],
    };
    const full = buildReportTokenMap([buildLeaf], []);
    const fullTokens = full.refs[0].tokens.map((t) => t.reportToken);
    expect(fullTokens).toContain("<<REDACTED_IP_R1_002>>");

    // The display loader used to replay over `analysis` only. That replay
    // never mints the factor-only token, so if aimer quoted the factor the
    // report-scope token would be left undecoded on the page (#297 review
    // round 2, item 1). Replaying the same analysis+factor bundle restores
    // identical numbering.
    const analysisOnly = buildReportTokenMap(
      [{ analysis: buildLeaf.analysis }],
      [],
    );
    expect(analysisOnly.refs[0].tokens.map((t) => t.reportToken)).not.toContain(
      "<<REDACTED_IP_R1_002>>",
    );

    const replay = buildReportTokenMap(
      [
        {
          analysis: buildLeaf.analysis,
          severityFactors: [],
          likelihoodFactors: buildLeaf.likelihoodFactors,
        },
      ],
      [],
    );
    expect(replay.refs[0].tokens).toEqual(full.refs[0].tokens);
  });

  it("rewrites event-leaf factors and keeps the analysis numbering stable", () => {
    const out = buildReportTokenMap(
      [],
      [
        {
          analysis: "Bare <<REDACTED_IP_001>> seen.",
          severityFactors: [
            "from <<REDACTED_IP_001>>",
            "to <<REDACTED_MAC_002>>",
          ],
        },
      ],
    );
    // Event leaf is j=1 here (no story leaves precede it).
    expect(out.rewrittenEventTexts[0]).toBe(
      "Bare <<REDACTED_IP_R1_001>> seen.",
    );
    expect(out.rewrittenEventFactors[0].severityFactors).toEqual([
      "from <<REDACTED_IP_R1_001>>",
      "to <<REDACTED_MAC_R1_002>>",
    ]);
    expect(out.rewrittenEventFactors[0].likelihoodFactors).toEqual([]);
  });
});

describe("scanReportAnalysisForLeaks", () => {
  const built = buildReportTokenMap(
    [{ analysis: "<<REDACTED_IP_E1_001>>" }],
    [{ analysis: "<<REDACTED_EMAIL_004>>" }],
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

  it("flags unknown-kind residual tokens the kind-pinned matchers miss (#380)", () => {
    // The redaction engine only emits IP/EMAIL/MAC, so a HOSTNAME token
    // is foreign to every kind-pinned matcher. The kind-agnostic
    // backstop must still fail the job for each scope: story `E{i}`,
    // bare event, and report `R{j}`.
    for (const token of [
      "<<REDACTED_HOSTNAME_E1_001>>",
      "<<REDACTED_HOSTNAME_001>>",
      "<<REDACTED_HOSTNAME_R1_001>>",
    ]) {
      const res = scanReportAnalysisForLeaks(
        `synthesized ${token}`,
        built.refs,
        EMPTY_RANGES,
      );
      expect(res.hasLeak).toBe(true);
      expect(res.leaks).toContainEqual(
        expect.objectContaining({ kind: "unknown_kind_token", match: token }),
      );
    }
  });

  it("does not flag a mapped report token via the backstop (no false positive)", () => {
    const res = scanReportAnalysisForLeaks(
      "actor at <<REDACTED_IP_R1_001>> mailed <<REDACTED_EMAIL_R2_001>>",
      built.refs,
      EMPTY_RANGES,
    );
    expect(res.hasLeak).toBe(false);
    expect(res.leaks.some((l) => l.kind === "unknown_kind_token")).toBe(false);
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

  // RFC 0001 Amendment A.2: an owned domain echoed in plaintext in the
  // report narrative is a leak; external domains pass through.
  it("flags an owned domain echoed verbatim, not an external one", () => {
    const owned = buildOwnedDomainSet(["customer.example"]);
    const res = scanReportAnalysisForLeaks(
      "Beacon from vpn.customer.example to evil-attacker.example.",
      built.refs,
      EMPTY_RANGES,
      owned,
    );
    const matches = res.leaks
      .filter((l) => l.kind === "plaintext_pii")
      .map((l) => l.match);
    expect(matches).toContain("vpn.customer.example");
    expect(matches).not.toContain("evil-attacker.example");
  });

  it("flags no domain when the owned set is empty (default arg)", () => {
    const res = scanReportAnalysisForLeaks(
      "Beacon from vpn.customer.example.",
      built.refs,
      EMPTY_RANGES,
    );
    expect(res.leaks.some((l) => l.match === "vpn.customer.example")).toBe(
      false,
    );
  });
});
