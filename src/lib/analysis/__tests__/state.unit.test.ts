import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isStoryReady } = await import("../state");

describe("isStoryReady", () => {
  const now = new Date("2026-05-27T12:00:00Z");

  it("returns false when first_member_at is null", () => {
    expect(isStoryReady(now, null, now)).toBe(false);
  });

  it("returns false when last_member_at is null", () => {
    expect(isStoryReady(now, now, null)).toBe(false);
  });

  it("returns false within the idle window and before max wait", () => {
    const last = new Date("2026-05-27T11:55:00Z"); // 5 min ago
    const first = new Date("2026-05-27T11:30:00Z"); // 30 min ago
    expect(isStoryReady(now, first, last)).toBe(false);
  });

  it("returns true when the idle window has elapsed", () => {
    const last = new Date("2026-05-27T11:40:00Z"); // 20 min ago > 15 min idle
    const first = new Date("2026-05-27T11:30:00Z");
    expect(isStoryReady(now, first, last)).toBe(true);
  });

  it("returns true when the max wait has elapsed even if still trickling", () => {
    const last = new Date("2026-05-27T11:59:00Z"); // 1 min ago
    const first = new Date("2026-05-27T05:00:00Z"); // 7h ago > 6h max
    expect(isStoryReady(now, first, last)).toBe(true);
  });

  it("respects custom thresholds", () => {
    const last = new Date("2026-05-27T11:50:00Z"); // 10 min ago
    const first = new Date("2026-05-27T11:30:00Z");
    expect(isStoryReady(now, first, last, 5, 24)).toBe(true);
    expect(isStoryReady(now, first, last, 30, 24)).toBe(false);
  });
});
