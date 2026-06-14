// RFC 0005 (#612) — the F2 enumerable seam: CVE sources surfaced to the
// per-customer/group selection model as a DISTINCT source kind.
//
// Pins that #611's `allCveSourceDescriptors()` reaches the selection model via
// the `cveSourceCatalog` DTO (kind: "cve", keyed on `sourceId`), that
// `selectEnabledCveSources` stays the default-all-enabled gating seam, that no
// CVE id leaks into #598's IOC `sourcePolicyId` namespace, and that the CVE
// feature gate is left off.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ALL_CVE_SOURCES, CVE_SOURCE_LABELS } from "../catalog";
import {
  CVE_ENRICHMENT_ENABLED,
  cveSourceCatalog,
  selectEnabledCveSources,
} from "../config";

describe("cveSourceCatalog — the CVE enumerable seam", () => {
  it("surfaces every registered CVE source in citation order", () => {
    const entries = cveSourceCatalog();
    expect(entries.map((e) => e.sourceId)).toEqual([...ALL_CVE_SOURCES]);
  });

  it("maps each descriptor to the narrow DTO (kind/sourceId/label/enabled)", () => {
    const entries = cveSourceCatalog();
    for (const entry of entries) {
      expect(entry.kind).toBe("cve");
      expect(entry.label).toBe(CVE_SOURCE_LABELS[entry.sourceId]);
      // Narrow DTO: never leaks the descriptor internals (fetch/parse/maxAge)
      // nor an IOC-style `sourcePolicyId`.
      expect(Object.keys(entry).sort()).toEqual([
        "enabled",
        "kind",
        "label",
        "sourceId",
      ]);
    }
  });

  it("flags every source enabled by default (selectEnabledCveSources all-enabled)", () => {
    expect(cveSourceCatalog().every((e) => e.enabled)).toBe(true);
    expect([...selectEnabledCveSources()].sort()).toEqual(
      [...ALL_CVE_SOURCES].sort(),
    );
  });

  it("keeps CVE ids out of the IOC sourcePolicyId namespace (no conflation)", async () => {
    const { allTiSourceDescriptors } = await import(
      "../../enrichment/sources/registry"
    );
    await import("../../enrichment/sources");
    const iocIds = new Set(
      allTiSourceDescriptors().map((d) => d.sourcePolicyId),
    );
    for (const id of ALL_CVE_SOURCES) {
      expect(iocIds.has(id)).toBe(false);
    }
  });

  it("leaves the CVE enrichment gate off by default", () => {
    expect(CVE_ENRICHMENT_ENABLED).toBe(false);
  });
});
