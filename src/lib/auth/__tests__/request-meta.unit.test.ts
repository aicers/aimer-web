import { describe, expect, it } from "vitest";
import { extractRequestMeta } from "../request-meta";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost/test", { headers });
}

describe("extractRequestMeta", () => {
  it("extracts IP from x-forwarded-for", () => {
    const meta = extractRequestMeta(
      makeRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
    );
    expect(meta.ipAddress).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const meta = extractRequestMeta(makeRequest({ "x-real-ip": "10.0.0.1" }));
    expect(meta.ipAddress).toBe("10.0.0.1");
  });

  it("defaults to 'unknown' when no IP headers", () => {
    const meta = extractRequestMeta(makeRequest({}));
    expect(meta.ipAddress).toBe("unknown");
  });

  it("extracts user-agent", () => {
    const meta = extractRequestMeta(
      makeRequest({ "user-agent": "TestBrowser/1.0" }),
    );
    expect(meta.userAgent).toBe("TestBrowser/1.0");
  });

  it("extracts origin", () => {
    const meta = extractRequestMeta(
      makeRequest({ origin: "https://localhost" }),
    );
    expect(meta.origin).toBe("https://localhost");
  });

  it("falls back to referer when origin is absent", () => {
    const meta = extractRequestMeta(
      makeRequest({ referer: "https://localhost/page" }),
    );
    expect(meta.origin).toBe("https://localhost/page");
  });
});
