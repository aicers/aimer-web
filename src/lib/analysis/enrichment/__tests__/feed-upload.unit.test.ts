// RFC 0003 Tier-1 feed-refresh (#566) — manual-upload helper unit tests
// (pure: no DB, no request/response).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertParseableUpload,
  buildManualUploadPayload,
  FeedUploadError,
  hasFeedDataLines,
  manualUploadModeActive,
} from "../feed-upload";

describe("manualUploadModeActive", () => {
  it("is true only for the manual-upload mode", () => {
    expect(manualUploadModeActive("manual-upload")).toBe(true);
    expect(manualUploadModeActive("fixture")).toBe(false);
    // reserved-but-unimplemented modes make resolveTiFeedMode throw → inactive
    expect(manualUploadModeActive("self-fetch")).toBe(false);
    expect(manualUploadModeActive("managed")).toBe(false);
    // unknown/typo → inactive (no throw escapes)
    expect(manualUploadModeActive("bogus")).toBe(false);
  });

  it("reads TI_FEED_MODE when no value passed", () => {
    const prev = process.env.TI_FEED_MODE;
    process.env.TI_FEED_MODE = "manual-upload";
    try {
      expect(manualUploadModeActive()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TI_FEED_MODE;
      else process.env.TI_FEED_MODE = prev;
    }
  });
});

describe("hasFeedDataLines", () => {
  it("treats blank and #/; comment lines as non-data", () => {
    expect(hasFeedDataLines("")).toBe(false);
    expect(hasFeedDataLines("\n\n  \n")).toBe(false);
    expect(hasFeedDataLines("# a comment\n; another\n")).toBe(false);
  });

  it("detects a real data line", () => {
    expect(hasFeedDataLines("# header\n45.66.230.5\n")).toBe(true);
  });
});

describe("buildManualUploadPayload", () => {
  it("builds a RawFeedPayload from catalog fields + upload provenance", () => {
    const payload = buildManualUploadPayload({
      sourcePolicyId: "abuse.ch/feodo",
      filename: "feodo.txt",
      content: "45.66.230.5\n",
      uploadedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(payload).toEqual({
      sourcePolicyId: "abuse.ch/feodo",
      parse: "ip-blocklist",
      entityType: "IP",
      hitType: "deterministic_ioc",
      classification: "c2",
      content: "45.66.230.5\n",
      provenance: {
        mode: "manual-upload",
        origin: "manual-upload:feodo.txt",
        sourceUpdatedAt: "2026-06-12T00:00:00.000Z",
      },
    });
  });

  it("rejects an unknown sourcePolicyId", () => {
    expect(() =>
      buildManualUploadPayload({
        sourcePolicyId: "bogus/source",
        filename: "x.txt",
        content: "data\n",
        uploadedAt: "2026-06-12T00:00:00.000Z",
      }),
    ).toThrow(FeedUploadError);
  });

  it("rejects a vendor-repo source (self-fetch only, no single-file upload)", () => {
    // A vendor-repo source (unit42/threat-intel) is a whole-repo tree, not a
    // single uploadable file — a one-file upload would write a partial,
    // context-stripped snapshot, so manual upload is rejected outright.
    expect(() =>
      buildManualUploadPayload({
        sourcePolicyId: "unit42/threat-intel",
        filename: "iocs.txt",
        content: "1.2.3.4\n",
        uploadedAt: "2026-06-12T00:00:00.000Z",
      }),
    ).toThrow(/vendor repository and cannot be manually uploaded/);
  });
});

describe("assertParseableUpload", () => {
  const base = {
    filename: "f.txt",
    uploadedAt: "2026-06-12T00:00:00.000Z",
  };

  it("accepts content that parses to rows", () => {
    const payload = buildManualUploadPayload({
      ...base,
      sourcePolicyId: "abuse.ch/feodo",
      content: "45.66.230.5\n198.51.100.7\n",
    });
    expect(() => assertParseableUpload(payload)).not.toThrow();
  });

  it("accepts genuinely empty / comment-only content (clears the source)", () => {
    const payload = buildManualUploadPayload({
      ...base,
      sourcePolicyId: "abuse.ch/feodo",
      content: "# only comments\n\n",
    });
    expect(() => assertParseableUpload(payload)).not.toThrow();
  });

  it("rejects unparseable non-empty content (data lines, zero rows)", () => {
    // URLhaus expects quoted CSV with >= 3 fields; plain prose yields no rows.
    const payload = buildManualUploadPayload({
      ...base,
      sourcePolicyId: "abuse.ch/urlhaus",
      content: "this is not a csv\nnope\n",
    });
    expect(() => assertParseableUpload(payload)).toThrow(FeedUploadError);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
