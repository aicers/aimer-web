import { describe, expect, it } from "vitest";
import { validateExpectedOriginEnv } from "../expected-origin";

describe("validateExpectedOriginEnv", () => {
  it("throws in production when value is unset", () => {
    expect(() => validateExpectedOriginEnv(undefined, "production")).toThrow(
      /EXPECTED_ORIGIN is required in production/,
    );
    expect(() => validateExpectedOriginEnv("", "production")).toThrow(
      /EXPECTED_ORIGIN is required in production/,
    );
  });

  it("returns null in non-production when value is unset", () => {
    expect(validateExpectedOriginEnv(undefined, "development")).toBeNull();
    expect(validateExpectedOriginEnv("", "test")).toBeNull();
  });

  it("returns canonicalised origin for valid value in production", () => {
    expect(
      validateExpectedOriginEnv("https://aimer-web.example.com", "production"),
    ).toBe("https://aimer-web.example.com");
  });

  it("returns canonicalised origin for valid value in development", () => {
    expect(
      validateExpectedOriginEnv("https://aimer-web.example.com", "development"),
    ).toBe("https://aimer-web.example.com");
  });

  it("normalises trailing slash to identical canonical origin", () => {
    expect(
      validateExpectedOriginEnv("https://aimer-web.example.com", "production"),
    ).toBe(
      validateExpectedOriginEnv("https://aimer-web.example.com/", "production"),
    );
  });

  it("lowercases scheme and host", () => {
    expect(
      validateExpectedOriginEnv("HTTPS://AIMER-WEB.EXAMPLE.COM", "production"),
    ).toBe("https://aimer-web.example.com");
  });

  it("preserves non-default port", () => {
    expect(
      validateExpectedOriginEnv(
        "https://aimer-web.test.local:19443",
        "production",
      ),
    ).toBe("https://aimer-web.test.local:19443");
  });

  it("throws when value is malformed", () => {
    expect(() => validateExpectedOriginEnv("not-a-url", "production")).toThrow(
      /malformed/,
    );
  });

  it("throws when value uses a non-http(s) scheme", () => {
    // `file:` parses with `url.origin === "null"` (opaque origin); without an
    // explicit scheme check this would canonicalise to the literal string
    // "null" and every later URL construction call would throw `Invalid URL`
    // at request time instead of failing fast at startup.
    expect(() =>
      validateExpectedOriginEnv("file://localhost/", "production"),
    ).toThrow(/must use http: or https: scheme/);
    expect(() =>
      validateExpectedOriginEnv("ftp://aimer-web.example.com", "production"),
    ).toThrow(/must use http: or https: scheme/);
    expect(() =>
      validateExpectedOriginEnv("ws://aimer-web.example.com", "production"),
    ).toThrow(/must use http: or https: scheme/);
  });

  it("throws when value contains a path", () => {
    expect(() =>
      validateExpectedOriginEnv(
        "https://aimer-web.example.com/foo",
        "production",
      ),
    ).toThrow(/must not contain a path/);
  });

  it("throws when value contains a query", () => {
    expect(() =>
      validateExpectedOriginEnv(
        "https://aimer-web.example.com?x=1",
        "production",
      ),
    ).toThrow(/must not contain query or hash/);
  });

  it("throws when value contains a hash", () => {
    expect(() =>
      validateExpectedOriginEnv(
        "https://aimer-web.example.com#frag",
        "production",
      ),
    ).toThrow(/must not contain query or hash/);
  });
});
