// Unit tests for the pure (DB-free) parts of the TI-source selection service
// (#598): the public catalog DTO never leaks descriptor internals, and the
// shared write validation rejects empty / unknown / malformed input.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HttpError } from "../../auth/errors";
import { allTiSourceDescriptors } from "../enrichment/sources/registry";
import {
  allEnabledSourceIds,
  parseEnabledSourceIdsInput,
  toCatalogDto,
} from "../ti-sources";

// Keys that are internal to a descriptor and must NEVER appear in the DTO.
const FORBIDDEN_KEYS = [
  "parse",
  "fetch",
  "fixtureFile",
  "maxAge",
  "hitType",
  "entityType",
  "deterministicCoverage",
  "floorEligible",
  "classification",
];

describe("toCatalogDto", () => {
  it("exposes only the public keys for every registered source", () => {
    const dto = toCatalogDto([]);
    expect(dto.length).toBe(allTiSourceDescriptors().length);
    for (const entry of dto) {
      expect(Object.keys(entry).sort()).toEqual([
        "enabled",
        "entityTypes",
        "label",
        "requiresCustomerKey",
        "sourcePolicyId",
      ]);
      for (const k of FORBIDDEN_KEYS) {
        expect(k in entry).toBe(false);
      }
      // The Tier-2 seam is present and defaults to false (no key plumbing).
      expect(entry.requiresCustomerKey).toBe(false);
    }
  });

  it("flags enabled against the provided set", () => {
    const all = allEnabledSourceIds();
    const dto = toCatalogDto([all[0]]);
    expect(dto.find((e) => e.sourcePolicyId === all[0])?.enabled).toBe(true);
    expect(dto.filter((e) => e.enabled)).toHaveLength(1);
  });
});

describe("parseEnabledSourceIdsInput", () => {
  it("returns a de-duplicated sorted list for a valid selection", () => {
    const all = allEnabledSourceIds();
    const pick = [all[1], all[0], all[0]];
    expect(parseEnabledSourceIdsInput({ enabledSourceIds: pick })).toEqual(
      [all[0], all[1]].sort(),
    );
  });

  it("rejects an empty selection with 422", () => {
    expect(() =>
      parseEnabledSourceIdsInput({ enabledSourceIds: [] }),
    ).toThrowError(expect.objectContaining({ statusCode: 422 }));
  });

  it("rejects an unknown sourcePolicyId with 422", () => {
    const all = allEnabledSourceIds();
    expect(() =>
      parseEnabledSourceIdsInput({ enabledSourceIds: [all[0], "ghost/x"] }),
    ).toThrowError(expect.objectContaining({ statusCode: 422 }));
  });

  it("rejects a malformed body with 400", () => {
    expect(() => parseEnabledSourceIdsInput(null)).toThrowError(HttpError);
    expect(() => parseEnabledSourceIdsInput({})).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() =>
      parseEnabledSourceIdsInput({ enabledSourceIds: [1, 2] }),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});
