import { describe, expect, test, vi } from "vitest";
import {
  groupDbName,
  groupDbUrl,
  groupLockId,
  groupTransitKeyName,
} from "../group-db";

// Bypass server-only guard in test environment
vi.mock("server-only", () => ({}));

describe("groupDbName", () => {
  test("strips hyphens from UUID", () => {
    expect(groupDbName("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "group_a1b2c3d4e5f67890abcdef1234567890",
    );
  });

  test("handles UUID without hyphens", () => {
    expect(groupDbName("a1b2c3d4e5f67890abcdef1234567890")).toBe(
      "group_a1b2c3d4e5f67890abcdef1234567890",
    );
  });
});

describe("groupTransitKeyName", () => {
  test("preserves hyphens in UUID", () => {
    expect(groupTransitKeyName("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "group-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });
});

describe("groupLockId", () => {
  test("returns a positive integer in the group range", () => {
    const id = groupLockId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(id).toBeGreaterThanOrEqual(1_500_000_000);
    expect(Number.isInteger(id)).toBe(true);
  });

  test("returns same ID for same input", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(groupLockId(uuid)).toBe(groupLockId(uuid));
  });

  test("returns different IDs for different inputs", () => {
    const id1 = groupLockId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    const id2 = groupLockId("b2c3d4e5-f6a7-8901-bcde-f12345678901");
    expect(id1).not.toBe(id2);
  });

  test("does not collide with the customer lock-id range", async () => {
    const { customerLockId } = await import("../customer-db");
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    // Customer ids land in 2000 – 1_002_000; group ids start at 1.5e9.
    expect(customerLockId(uuid)).toBeLessThan(1_500_000_000);
    expect(groupLockId(uuid)).toBeGreaterThanOrEqual(1_500_000_000);
  });
});

describe("groupDbUrl", () => {
  test("replaces database name in template URL", () => {
    const template = "postgresql://owner:pass@localhost:5432/placeholder";
    const result = groupDbUrl(template, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result).toBe(
      "postgresql://owner:pass@localhost:5432/group_a1b2c3d4e5f67890abcdef1234567890",
    );
  });

  test("preserves query parameters", () => {
    const template =
      "postgresql://owner:pass@localhost:5432/placeholder?sslmode=require";
    const result = groupDbUrl(template, "abc-def-123");
    expect(result).toBe(
      "postgresql://owner:pass@localhost:5432/group_abcdef123?sslmode=require",
    );
  });
});
