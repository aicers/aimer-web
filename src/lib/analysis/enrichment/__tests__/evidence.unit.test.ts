import { describe, expect, it } from "vitest";
import { computeCoverage } from "../coverage";
import {
  buildEvidenceRecord,
  computeIndicatorHmac,
  HmacKeyRing,
  verifyIndicatorHmac,
} from "../evidence";
import { normalizeDomain } from "../normalization";
import { type SourcePolicy, SourcePolicyRegistry } from "../source-policy";
import type { EnrichmentMatch } from "../types";

const indicator = normalizeDomain("malware.example");

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

const v1Ring = new HmacKeyRing({ v1: "secret-key-one" }, "v1");

function buildRecord(ring = v1Ring, version?: string) {
  return buildEvidenceRecord({
    indicator,
    match,
    redactionToken: "E1",
    keyRing: ring,
    checkedAt: "2026-06-04T12:00:00.000Z",
    expiresAt: "2026-06-04T18:00:00.000Z",
    hmacKeyVersion: version,
  });
}

describe("evidence record + HMAC", () => {
  it("populates the record from the match without storing plaintext", () => {
    const record = buildRecord();
    expect(record.redactionToken).toBe("E1");
    expect(record.sourcePolicyId).toBe("abuse.ch/urlhaus");
    expect(record.feedHash).toBe("urlhaus-snapshot-0007");
    expect(record.hitType).toBe("deterministic_ioc");
    expect(record.floorEligible).toBe(true);
    expect(record.normalizationVersion).toBe(indicator.normalizationVersion);
    expect(record.hmacKeyVersion).toBe("v1");
    // No field carries the raw indicator value, and the HMAC is a hex digest.
    expect(JSON.stringify(record)).not.toContain(indicator.value);
    expect(record.normalizedIndicatorHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recomputing the HMAC over the same indicator verifies the record", () => {
    const record = buildRecord();
    expect(verifyIndicatorHmac(indicator, record, v1Ring)).toBe(true);
  });

  it("a tampered / different indicator fails verification", () => {
    const record = buildRecord();
    const other = normalizeDomain("benign.example");
    expect(verifyIndicatorHmac(other, record, v1Ring)).toBe(false);
  });

  it("verifies across a key-version rotation (old version still verifies)", () => {
    // Record stamped with v1.
    const record = buildRecord(v1Ring, "v1");
    // Rotate: v2 is now current, but the ring retains v1.
    const rotated = new HmacKeyRing(
      { v1: "secret-key-one", v2: "secret-key-two" },
      "v2",
    );
    expect(verifyIndicatorHmac(indicator, record, rotated)).toBe(true);

    // A fresh record now stamps with the current (v2) key and still verifies.
    const newRecord = buildRecord(rotated);
    expect(newRecord.hmacKeyVersion).toBe("v2");
    expect(verifyIndicatorHmac(indicator, newRecord, rotated)).toBe(true);
  });

  it("fails verification when the record's key version is unknown to the ring", () => {
    const record = buildRecord(v1Ring, "v1");
    const ringWithoutV1 = new HmacKeyRing({ v2: "secret-key-two" }, "v2");
    expect(verifyIndicatorHmac(indicator, record, ringWithoutV1)).toBe(false);
  });

  it("different keys produce different digests for the same indicator", () => {
    const a = computeIndicatorHmac(indicator, v1Ring).normalizedIndicatorHmac;
    const b = computeIndicatorHmac(
      indicator,
      new HmacKeyRing({ v1: "a-different-key" }, "v1"),
    ).normalizedIndicatorHmac;
    expect(a).not.toBe(b);
  });

  it("rejects constructing a ring whose current version is absent", () => {
    expect(() => new HmacKeyRing({ v1: "k" }, "v9")).toThrow();
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
      indicator,
      match,
      redactionToken: "E1",
      keyRing: v1Ring,
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
