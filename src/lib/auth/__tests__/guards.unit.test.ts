import { describe, expect, it } from "vitest";

describe("guard utilities", () => {
  describe("Origin verification logic", () => {
    function checkOrigin(
      requestOrigin: string | null,
      expectedOrigin: string,
    ): boolean {
      if (!requestOrigin) return false;
      try {
        return new URL(requestOrigin).origin === expectedOrigin;
      } catch {
        return false;
      }
    }

    it("accepts matching origin", () => {
      expect(
        checkOrigin("http://localhost:3000", "http://localhost:3000"),
      ).toBe(true);
    });

    it("rejects different origin", () => {
      expect(checkOrigin("http://evil.com", "http://localhost:3000")).toBe(
        false,
      );
    });

    it("rejects null origin", () => {
      expect(checkOrigin(null, "http://localhost:3000")).toBe(false);
    });

    it("rejects malformed origin", () => {
      expect(checkOrigin("not-a-url", "http://localhost:3000")).toBe(false);
    });

    it("accepts origin with path (strips path for comparison)", () => {
      expect(
        checkOrigin("http://localhost:3000/some/path", "http://localhost:3000"),
      ).toBe(true);
    });

    it("rejects different port", () => {
      expect(
        checkOrigin("http://localhost:4000", "http://localhost:3000"),
      ).toBe(false);
    });

    it("rejects different protocol", () => {
      expect(
        checkOrigin("http://localhost:3000", "https://localhost:3000"),
      ).toBe(false);
    });
  });

  describe("session policy timeout logic", () => {
    function isIdleExpired(
      lastActiveAt: number,
      now: number,
      idleTimeoutMinutes: number,
    ): boolean {
      return now - lastActiveAt > idleTimeoutMinutes * 60;
    }

    function isAbsoluteExpired(
      createdAt: number,
      now: number,
      absoluteTimeoutMinutes: number,
    ): boolean {
      return now - createdAt > absoluteTimeoutMinutes * 60;
    }

    const now = 1700000000;

    it("not idle-expired when recently active", () => {
      expect(isIdleExpired(now - 600, now, 30)).toBe(false); // 10 min ago
    });

    it("idle-expired after timeout", () => {
      expect(isIdleExpired(now - 1801, now, 30)).toBe(true); // 30min + 1s
    });

    it("not absolute-expired within window", () => {
      expect(isAbsoluteExpired(now - 3600, now, 480)).toBe(false); // 1h ago
    });

    it("absolute-expired after max lifetime", () => {
      expect(isAbsoluteExpired(now - 28801, now, 480)).toBe(true); // 8h + 1s
    });
  });
});
