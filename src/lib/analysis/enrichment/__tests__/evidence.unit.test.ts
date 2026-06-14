import { describe, expect, it } from "vitest";
import { computeCoverage } from "../coverage";
import {
  buildEvidenceRecord,
  evidenceIsFloorSupporting,
  SOFT_REPUTATION_CONFIDENCE_THRESHOLD,
  surfacesSoftMatch,
} from "../evidence";
import { type SourcePolicy, SourcePolicyRegistry } from "../source-policy";
import type { EnrichmentMatch } from "../types";

const match: EnrichmentMatch = {
  source: "abuse.ch/urlhaus",
  sourcePolicyId: "abuse.ch/urlhaus",
  hitType: "deterministic_ioc",
  floorEligible: true,
  classification: "malware_download",
  sourceVersion: "2026-06-02",
  feedHash: "urlhaus-snapshot-0007",
  sourceUpdatedAt: "2026-06-04T00:00:00.000Z",
};

function buildRecord() {
  return buildEvidenceRecord({
    match,
    redactionToken: "45.66.230.5",
    sourceAiceId: "aice-1",
    memberEventKey: "1",
    checkedAt: "2026-06-04T12:00:00.000Z",
    expiresAt: "2026-06-04T18:00:00.000Z",
  });
}

describe("evidence record", () => {
  it("populates the record from the match with the redaction-token reference", () => {
    const record = buildRecord();
    // External indicator → `redactionToken` carries the raw value.
    expect(record.redactionToken).toBe("45.66.230.5");
    expect(record.sourcePolicyId).toBe("abuse.ch/urlhaus");
    expect(record.sourceVersion).toBe("2026-06-02");
    expect(record.feedHash).toBe("urlhaus-snapshot-0007");
    expect(record.sourceUpdatedAt).toBe("2026-06-04T00:00:00.000Z");
    expect(record.hitType).toBe("deterministic_ioc");
    expect(record.floorEligible).toBe(true);
    expect(record.checkedAt).toBe("2026-06-04T12:00:00.000Z");
    expect(record.expiresAt).toBe("2026-06-04T18:00:00.000Z");
    // The event redaction-map scope is carried so a customer-asset token is
    // recoverable and a raw external hit records which member event it came from.
    expect(record.sourceAiceId).toBe("aice-1");
    expect(record.memberEventKey).toBe("1");
  });

  it("carries the coverage report computed from a merged result", () => {
    const checkedAt = "2026-06-04T12:00:00.000Z";
    const policy: SourcePolicy = {
      sourcePolicyId: "abuse.ch/urlhaus",
      label: "abuse.ch/urlhaus",
      entityTypes: ["DOMAIN"],
      deterministicCoverage: true,
      maxAge: 60 * 60 * 1000,
      floorEligible: true,
    };
    const registry = new SourcePolicyRegistry([policy]);
    // A merged dispatch where the one relevant source answered fresh.
    const coverage = computeCoverage(
      "DOMAIN",
      [
        {
          sourcePolicyId: "abuse.ch/urlhaus",
          answered: true,
          sourceUpdatedAt: "2026-06-04T11:45:00.000Z",
        },
      ],
      registry,
      checkedAt,
    );
    expect(coverage.status).toBe("complete");

    const record = buildEvidenceRecord({
      match,
      redactionToken: "45.66.230.5",
      sourceAiceId: "aice-1",
      memberEventKey: "1",
      checkedAt,
      coverage,
    });
    // The full report (enum + raw counts) is recorded on the evidence model,
    // so the #361 persistence follow-up has a typed home for it.
    expect(record.coverage).toEqual(coverage);
    expect(record.coverage?.status).toBe("complete");
    expect(record.coverage?.expectedCount).toBe(1);
    expect(record.coverage?.answeredCount).toBe(1);
  });

  it("omits coverage when none is supplied (single-enricher, pre-merge)", () => {
    const record = buildRecord();
    expect(record.coverage).toBeUndefined();
  });
});

describe("meaningfulness gate (surfacesSoftMatch, #589)", () => {
  function soft(overrides: Partial<EnrichmentMatch> = {}): EnrichmentMatch {
    return {
      source: "soft/source-a",
      sourcePolicyId: "soft/source-a",
      hitType: "soft_reputation",
      floorEligible: false,
      ...overrides,
    };
  }

  it("promotes a soft match at/above the confidence threshold (single source)", () => {
    const m = soft({ confidence: SOFT_REPUTATION_CONFIDENCE_THRESHOLD });
    expect(surfacesSoftMatch(m, [m])).toBe(true);
  });

  it("does not promote a below-threshold single-source soft match", () => {
    const m = soft({ confidence: SOFT_REPUTATION_CONFIDENCE_THRESHOLD - 0.1 });
    expect(surfacesSoftMatch(m, [m])).toBe(false);
  });

  it("does not promote a soft match with no confidence and one source", () => {
    const m = soft();
    expect(surfacesSoftMatch(m, [m])).toBe(false);
  });

  it("promotes a below-threshold soft match corroborated by >= 2 distinct sources", () => {
    const a = soft({ sourcePolicyId: "soft/source-a", confidence: 0.1 });
    const b = soft({ sourcePolicyId: "soft/source-b", confidence: 0.1 });
    // Same indicator hit by two distinct sources → corroborated.
    expect(surfacesSoftMatch(a, [a, b])).toBe(true);
  });

  it("does not count repeated hits from the SAME source as corroboration", () => {
    const a = soft({ sourcePolicyId: "soft/source-a", confidence: 0.1 });
    const dup = soft({ sourcePolicyId: "soft/source-a", confidence: 0.1 });
    expect(surfacesSoftMatch(a, [a, dup])).toBe(false);
  });
});

describe("evidenceIsFloorSupporting (#589)", () => {
  it("is true only for floor-eligible deterministic_ioc rows", () => {
    expect(
      evidenceIsFloorSupporting(
        buildEvidenceRecord({
          match: {
            source: "s",
            sourcePolicyId: "s",
            hitType: "deterministic_ioc",
            floorEligible: true,
          },
          redactionToken: "1.2.3.4",
          sourceAiceId: "aice-1",
          memberEventKey: "1",
          checkedAt: "2026-06-04T12:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("is false for floor-ineligible deterministic and for soft rows", () => {
    const ineligibleDet = buildEvidenceRecord({
      match: {
        source: "s",
        sourcePolicyId: "s",
        hitType: "deterministic_ioc",
        floorEligible: false,
      },
      redactionToken: "1.2.3.4",
      sourceAiceId: "aice-1",
      memberEventKey: "1",
      checkedAt: "2026-06-04T12:00:00.000Z",
    });
    const softRow = buildEvidenceRecord({
      match: {
        source: "s",
        sourcePolicyId: "s",
        hitType: "soft_reputation",
        floorEligible: false,
      },
      redactionToken: "1.2.3.4",
      sourceAiceId: "aice-1",
      memberEventKey: "1",
      checkedAt: "2026-06-04T12:00:00.000Z",
    });
    expect(evidenceIsFloorSupporting(ineligibleDet)).toBe(false);
    expect(evidenceIsFloorSupporting(softRow)).toBe(false);
  });
});
