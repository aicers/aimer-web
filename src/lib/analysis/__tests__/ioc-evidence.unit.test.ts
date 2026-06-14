// Unit tests for the pure IOC evidence view model (#591): evidence-class
// derivation, the verdict render-state machine (the three legible states +
// hit), token detection, and the display comparator.

import { describe, expect, it } from "vitest";
import {
  classifyEvidence,
  compareEvidence,
  type IocEvidenceItem,
  iocVerdictState,
  isRedactionToken,
} from "../ioc-evidence";

describe("classifyEvidence", () => {
  it("classifies a floor-eligible deterministic IOC as floor-supporting", () => {
    expect(
      classifyEvidence({ hitType: "deterministic_ioc", floorEligible: true }),
    ).toBe("floor_supporting");
  });

  it("classifies a floor-ineligible deterministic IOC as supporting", () => {
    expect(
      classifyEvidence({ hitType: "deterministic_ioc", floorEligible: false }),
    ).toBe("floor_ineligible_deterministic");
  });

  it("classifies any soft-reputation match as promoted-soft", () => {
    expect(
      classifyEvidence({ hitType: "soft_reputation", floorEligible: false }),
    ).toBe("promoted_soft");
    // floor_eligible is meaningless for soft matches — still promoted_soft.
    expect(
      classifyEvidence({ hitType: "soft_reputation", floorEligible: true }),
    ).toBe("promoted_soft");
  });
});

describe("iocVerdictState", () => {
  it("renders not_run for a null verdict (never a clean verdict)", () => {
    expect(iocVerdictState(null)).toEqual({ kind: "not_run" });
  });

  it("renders hit for a known IOC", () => {
    expect(
      iocVerdictState({ knownIocHit: true, coverageStatus: "complete" }),
    ).toEqual({ kind: "hit", coverageStatus: "complete" });
  });

  it("renders clean_complete for false + complete (false-complete)", () => {
    expect(
      iocVerdictState({ knownIocHit: false, coverageStatus: "complete" }),
    ).toEqual({ kind: "clean_complete" });
  });

  it.each([
    "unknown",
    "stale",
    "partial",
  ] as const)("renders clean_incomplete for false + %s (false-unknown)", (status) => {
    expect(
      iocVerdictState({ knownIocHit: false, coverageStatus: status }),
    ).toEqual({ kind: "clean_incomplete", coverageStatus: status });
  });
});

describe("isRedactionToken", () => {
  it("matches exactly one event-scope redaction token", () => {
    expect(isRedactionToken("<<REDACTED_IP_001>>")).toBe(true);
    expect(isRedactionToken("<<REDACTED_EMAIL_12>>")).toBe(true);
    expect(isRedactionToken("<<REDACTED_DOMAIN_3>>")).toBe(true);
  });

  it("rejects raw external indicators and story E{i}/F{k} tokens", () => {
    expect(isRedactionToken("203.0.113.7")).toBe(false);
    expect(isRedactionToken("evil.example.com")).toBe(false);
    // Story-narrative leaf-replay tokens are NOT event-scope tokens.
    expect(isRedactionToken("<<REDACTED_IP_E1_001>>")).toBe(false);
    expect(isRedactionToken("prefix <<REDACTED_IP_001>>")).toBe(false);
  });
});

describe("compareEvidence", () => {
  function item(extras: Partial<IocEvidenceItem>): IocEvidenceItem {
    return {
      indicator: "x",
      indicatorRedacted: false,
      sourceAiceId: "a",
      memberEventKey: "1",
      sourceLabel: "L",
      sourcePolicyId: "p",
      hitType: "deterministic_ioc",
      floorEligible: true,
      evidenceClass: "floor_supporting",
      coverageStatus: "complete",
      sourceVersion: null,
      feedHash: null,
      checkedAt: new Date("2026-01-01T00:00:00Z"),
      ...extras,
    };
  }

  it("orders floor-supporting before the supporting classes", () => {
    const sorted = [
      item({ evidenceClass: "promoted_soft" }),
      item({ evidenceClass: "floor_supporting" }),
      item({ evidenceClass: "floor_ineligible_deterministic" }),
    ].sort(compareEvidence);
    expect(sorted.map((i) => i.evidenceClass)).toEqual([
      "floor_supporting",
      "floor_ineligible_deterministic",
      "promoted_soft",
    ]);
  });

  it("orders newest checked_at first within a class", () => {
    const older = item({ checkedAt: new Date("2026-01-01T00:00:00Z") });
    const newer = item({ checkedAt: new Date("2026-02-01T00:00:00Z") });
    expect([older, newer].sort(compareEvidence)[0]).toBe(newer);
  });
});
