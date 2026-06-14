// RFC 0005 (#611) — CVE source registration seam unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_CVE_SOURCES,
  CVE_SOURCE_LABELS,
  type CveSourceId,
} from "../../catalog";
import type { CveSourceDescriptor } from "../registry";

/** A descriptor for a valid core source, used to exercise registration. */
function descriptor(id: CveSourceId): CveSourceDescriptor {
  return {
    id,
    label: CVE_SOURCE_LABELS[id],
    maxAge: 1234,
    fetch: { url: "https://example.test/feed", cadenceFloorMs: 60_000 },
    parse: () => ({ rows: [] }),
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe("the three core sources register and enumerate", () => {
  it("allCveSourceDescriptors returns nvd/kev/epss in citation order", async () => {
    const { allCveSourceDescriptors } = await import("../index");
    const descriptors = allCveSourceDescriptors();
    expect(descriptors.map((d) => d.id)).toEqual(["nvd", "kev", "epss"]);
  });

  it("stays consistent with the closed CveSourceId union + labels", async () => {
    const { allCveSourceDescriptors } = await import("../index");
    const descriptors = allCveSourceDescriptors();
    expect(descriptors.map((d) => d.id).sort()).toEqual(
      [...ALL_CVE_SOURCES].sort(),
    );
    for (const d of descriptors) {
      expect(d.label).toBe(CVE_SOURCE_LABELS[d.id]);
    }
  });

  it("each core source carries behavioral config (fetch + parse + freshness)", async () => {
    const { allCveSourceDescriptors } = await import("../index");
    for (const d of allCveSourceDescriptors()) {
      expect(d.fetch.url).toMatch(/^https:\/\//);
      expect(d.fetch.cadenceFloorMs).toBeGreaterThan(0);
      expect(typeof d.parse).toBe("function");
      expect(d.maxAge).toBeGreaterThan(0);
    }
  });

  it("NVD declares paging + optional header API key; KEV/EPSS are keyless", async () => {
    const { getCveSourceDescriptor } = await import("../index");
    const nvd = getCveSourceDescriptor("nvd");
    expect(nvd?.fetch.paging?.resultsPerPage).toBeGreaterThan(0);
    expect(nvd?.fetch.authKeyName).toBe("nvd");
    expect(nvd?.fetch.authKeyHeader).toBe("apiKey");
    expect(getCveSourceDescriptor("kev")?.fetch.authKeyName).toBeUndefined();
    expect(getCveSourceDescriptor("epss")?.fetch.gzip).toBe(true);
  });
});

describe("registerCveSource guards", () => {
  it("rejects an id outside the closed CveSourceId union", async () => {
    const { registerCveSource } = await import("../registry");
    expect(() =>
      registerCveSource({
        ...descriptor("nvd"),
        id: "bogus" as CveSourceId,
      }),
    ).toThrow(/Unknown CVE source id/);
  });

  it("rejects a label that disagrees with CVE_SOURCE_LABELS", async () => {
    const { registerCveSource } = await import("../registry");
    expect(() =>
      registerCveSource({ ...descriptor("nvd"), label: "Wrong" }),
    ).toThrow(/disagrees/);
  });

  it("fails fast on a conflicting duplicate id", async () => {
    const { registerCveSource } = await import("../registry");
    registerCveSource(descriptor("kev"));
    expect(() =>
      registerCveSource({ ...descriptor("kev"), maxAge: 9999 }),
    ).toThrow(/Duplicate CVE source registration/);
  });

  it("is idempotent for a value-identical re-registration", async () => {
    const { registerCveSource, allCveSourceDescriptors } = await import(
      "../registry"
    );
    const parse = () => ({ rows: [] });
    const d: CveSourceDescriptor = { ...descriptor("epss"), parse };
    registerCveSource(d);
    expect(() => registerCveSource({ ...d, parse })).not.toThrow();
    expect(
      allCveSourceDescriptors().filter((x) => x.id === "epss"),
    ).toHaveLength(1);
  });
});
