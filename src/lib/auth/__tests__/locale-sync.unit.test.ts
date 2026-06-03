import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileSignInLocale } from "../locale-sync";

const mockQuery = vi.fn();
const client = { query: mockQuery } as unknown as Pool;

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("reconcileSignInLocale", () => {
  it("returns the saved locale and does not touch the DB", async () => {
    const result = await reconcileSignInLocale(client, ACCOUNT_ID, "en", "ko");
    expect(result).toBe("en");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("promotes a valid cookie to the account when the DB locale is NULL", async () => {
    const result = await reconcileSignInLocale(client, ACCOUNT_ID, null, "ko");
    expect(result).toBe("ko");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE accounts SET locale");
    expect(params).toEqual(["ko", ACCOUNT_ID]);
  });

  it("returns null when there is no saved preference and no valid cookie", async () => {
    const result = await reconcileSignInLocale(
      client,
      ACCOUNT_ID,
      null,
      undefined,
    );
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("ignores an invalid cookie value", async () => {
    const result = await reconcileSignInLocale(client, ACCOUNT_ID, null, "fr");
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("prefers a valid DB locale even when the cookie differs", async () => {
    const result = await reconcileSignInLocale(client, ACCOUNT_ID, "ko", "en");
    expect(result).toBe("ko");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("ignores an invalid DB locale and falls back to the cookie", async () => {
    const result = await reconcileSignInLocale(client, ACCOUNT_ID, "xx", "en");
    expect(result).toBe("en");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
