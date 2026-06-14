// RFC 0003 F6 (#594) — `EnrichmentContextPayload` narrowing + canonical
// serialization (pure, no DB).

import { describe, expect, it } from "vitest";
import { canonicalizeContext, narrowContextPayload } from "../context-payload";

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
