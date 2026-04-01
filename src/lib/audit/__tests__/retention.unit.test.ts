import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { purgeExpiredAuditLogs } = await import("../retention");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("purgeExpiredAuditLogs", () => {
  it("deletes anonymized rows older than retention window", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 42 });
    const pool = { query: mockQuery } as never;

    const result = await purgeExpiredAuditLogs(pool, 90);

    expect(result).toBe(42);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ip_address IS NULL"),
      [90],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("make_interval(days => $1)"),
      [90],
    );
  });

  it("defaults to 365 days when retentionDays is omitted", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 0 });
    const pool = { query: mockQuery } as never;

    await purgeExpiredAuditLogs(pool);

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [365]);
  });

  it("returns 0 when rowCount is null", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: null });
    const pool = { query: mockQuery } as never;

    const result = await purgeExpiredAuditLogs(pool);

    expect(result).toBe(0);
  });
});
