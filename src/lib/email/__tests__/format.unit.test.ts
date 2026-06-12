import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { escapeHtml, formatEmailTimestamp } from "../format";

describe("formatEmailTimestamp", () => {
  it("renders a UTC-pinned, labelled English timestamp", () => {
    expect(formatEmailTimestamp(new Date("2026-04-01T12:00:00Z"))).toBe(
      "April 1, 2026 at 12:00 PM UTC",
    );
  });

  it("renders end-of-year midnight-adjacent values in UTC", () => {
    expect(formatEmailTimestamp(new Date("2026-12-31T23:59:59Z"))).toBe(
      "December 31, 2026 at 11:59 PM UTC",
    );
  });

  it("is independent of the equivalent instant's expression", () => {
    // The same instant written with a +09:00 offset must format identically:
    // the output depends only on the instant and the pinned UTC zone, never on
    // the server's TZ or how the Date literal was written.
    const utc = new Date("2026-04-01T12:00:00Z");
    const offset = new Date("2026-04-01T21:00:00+09:00");
    expect(formatEmailTimestamp(offset)).toBe(formatEmailTimestamp(utc));
    expect(formatEmailTimestamp(offset)).toBe("April 1, 2026 at 12:00 PM UTC");
  });

  it("always labels the timezone as UTC", () => {
    expect(formatEmailTimestamp(new Date("2026-06-15T23:59:00Z"))).toContain(
      "UTC",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-sensitive characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Acme Corp")).toBe("Acme Corp");
  });
});
