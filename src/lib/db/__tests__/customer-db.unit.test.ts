import { describe, expect, test, vi } from "vitest";
import {
  customerDbName,
  customerDbUrl,
  customerLockId,
  customerTransitKeyName,
} from "../customer-db";

// Bypass server-only guard in test environment
vi.mock("server-only", () => ({}));

describe("customerDbName", () => {
  test("strips hyphens from UUID", () => {
    expect(customerDbName("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "customer_a1b2c3d4e5f67890abcdef1234567890",
    );
  });

  test("handles UUID without hyphens", () => {
    expect(customerDbName("a1b2c3d4e5f67890abcdef1234567890")).toBe(
      "customer_a1b2c3d4e5f67890abcdef1234567890",
    );
  });
});

describe("customerTransitKeyName", () => {
  test("preserves hyphens in UUID", () => {
    expect(customerTransitKeyName("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "customer-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });
});

describe("customerLockId", () => {
  test("returns a positive integer >= 2000", () => {
    const id = customerLockId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(id).toBeGreaterThanOrEqual(2000);
    expect(Number.isInteger(id)).toBe(true);
  });

  test("returns same ID for same input", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(customerLockId(uuid)).toBe(customerLockId(uuid));
  });

  test("returns different IDs for different inputs", () => {
    const id1 = customerLockId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    const id2 = customerLockId("b2c3d4e5-f6a7-8901-bcde-f12345678901");
    expect(id1).not.toBe(id2);
  });
});

describe("customerDbUrl", () => {
  test("replaces database name in template URL", () => {
    const template = "postgresql://owner:pass@localhost:5432/placeholder";
    const result = customerDbUrl(
      template,
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toBe(
      "postgresql://owner:pass@localhost:5432/customer_a1b2c3d4e5f67890abcdef1234567890",
    );
  });

  test("preserves query parameters", () => {
    const template =
      "postgresql://owner:pass@localhost:5432/placeholder?sslmode=require";
    const result = customerDbUrl(template, "abc-def-123");
    expect(result).toBe(
      "postgresql://owner:pass@localhost:5432/customer_abcdef123?sslmode=require",
    );
  });
});
