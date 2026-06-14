// RFC 0003 F6 (#594) — `EnrichmentContextPayload` narrowing + canonical
// serialization (pure, no DB).

import { describe, expect, it } from "vitest";
import {
  canonicalizeContext,
  narrowContextPayload,
  normalizeContext,
} from "../context-payload";

describe("narrowContextPayload", () => {
  it("narrows a well-formed JSONB context to the typed payload", () => {
    expect(
      narrowContextPayload({
        actor: "Sandworm",
        campaign: "BlackEnergy",
        malwareFamily: "Industroyer",
        reportUrl: "https://vendor.example/report",
        extra: { tlp: "amber" },
      }),
    ).toEqual({
      actor: "Sandworm",
      campaign: "BlackEnergy",
      malwareFamily: "Industroyer",
      reportUrl: "https://vendor.example/report",
      extra: { tlp: "amber" },
    });
  });

  it("keeps only the well-typed fields, dropping unexpected shapes", () => {
    expect(
      narrowContextPayload({
        actor: "APT1",
        campaign: 42, // wrong type → dropped
        malwareFamily: null, // wrong type → dropped
        reportUrl: ["x"], // wrong type → dropped
        extra: [1, 2, 3], // array, not a plain object → dropped
        unknownKey: "ignored",
      }),
    ).toEqual({ actor: "APT1" });
  });

  it("returns undefined for null / non-object / empty / all-unexpected input", () => {
    expect(narrowContextPayload(null)).toBeUndefined();
    expect(narrowContextPayload("string")).toBeUndefined();
    expect(narrowContextPayload(123)).toBeUndefined();
    expect(narrowContextPayload([1, 2])).toBeUndefined();
    expect(narrowContextPayload({})).toBeUndefined();
    expect(narrowContextPayload({ nope: true })).toBeUndefined();
  });

  it("drops an empty extra so it does not leave a meaningless {extra:{}}", () => {
    // A legacy / hand-edited row storing {extra:{}} carries no usable
    // context; it must narrow to undefined, not {extra:{}}.
    expect(narrowContextPayload({ extra: {} })).toBeUndefined();
    expect(narrowContextPayload({ actor: "APT1", extra: {} })).toEqual({
      actor: "APT1",
    });
  });
});

describe("normalizeContext", () => {
  it("drops undefined-valued properties to match the persisted JSON", () => {
    // The INSERT stores JSON.stringify(context), which omits undefined
    // properties; normalizeContext must produce the same shape so the hash
    // and the stored row agree. {actor:"APT1", campaign:undefined} must be
    // indistinguishable from {actor:"APT1"}.
    expect(normalizeContext({ actor: "APT1", campaign: undefined })).toEqual({
      actor: "APT1",
    });
  });

  it("drops nested undefined values inside extra", () => {
    expect(normalizeContext({ extra: { a: 1, b: undefined } })).toEqual({
      extra: { a: 1 },
    });
  });

  it("collapses an all-undefined payload to undefined (no non-null {} row)", () => {
    expect(normalizeContext({ actor: undefined })).toBeUndefined();
    expect(normalizeContext({})).toBeUndefined();
  });

  it("prunes an extra emptied by nested-undefined cleanup", () => {
    // {extra:{a:undefined}} cleans to {extra:{}}, which carries no usable
    // context; it must collapse to undefined like an all-undefined payload,
    // so the INSERT stores NULL and the hash sees no context (no phantom
    // provenance churn through the nested `extra` bag).
    expect(normalizeContext({ extra: { a: undefined } })).toBeUndefined();
    expect(
      normalizeContext({ actor: "APT1", extra: { a: undefined } }),
    ).toEqual({ actor: "APT1" });
  });

  it("preserves a non-empty extra", () => {
    expect(normalizeContext({ extra: { tlp: "amber" } })).toEqual({
      extra: { tlp: "amber" },
    });
  });

  it("yields the same JSON the INSERT path stores", () => {
    const payload = { actor: "APT1", campaign: undefined, reportUrl: "u" };
    const normalized = normalizeContext(payload);
    // Stored value is JSON.stringify of the normalized payload; round-tripping
    // the raw payload through JSON.stringify must match.
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(payload));
  });
});

describe("canonicalizeContext", () => {
  it("is stable regardless of object key-insertion order", () => {
    const a = canonicalizeContext({
      actor: "APT1",
      campaign: "Op",
      extra: { z: 1, a: 2 },
    });
    const b = canonicalizeContext({
      extra: { a: 2, z: 1 },
      campaign: "Op",
      actor: "APT1",
    });
    expect(a).toBe(b);
  });

  it("differs for different context content", () => {
    expect(canonicalizeContext({ actor: "A" })).not.toBe(
      canonicalizeContext({ actor: "B" }),
    );
  });
});
