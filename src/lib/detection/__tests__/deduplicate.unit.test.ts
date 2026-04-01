import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COOLDOWN_MINUTES,
  isDuplicate,
} from "../analyzers/deduplicate";

function mockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

describe("DEFAULT_COOLDOWN_MINUTES", () => {
  it("is 60", () => {
    expect(DEFAULT_COOLDOWN_MINUTES).toBe(60);
  });
});

describe("isDuplicate", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when no matching rows exist", async () => {
    const pool = mockPool([]);
    const result = await isDuplicate(pool, "bridge_abuse", 60, {
      actorId: "actor-1",
    });
    expect(result).toBe(false);
  });

  it("returns true when matching rows exist", async () => {
    const pool = mockPool([{ "?column?": 1 }]);
    const result = await isDuplicate(pool, "bridge_abuse", 60, {
      actorId: "actor-1",
    });
    expect(result).toBe(true);
  });

  it("builds query with actorId condition", async () => {
    const pool = mockPool();
    await isDuplicate(pool, "consecutive_sign_in_denials", 60, {
      actorId: "actor-1",
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("indicator = $1");
    expect(sql).toContain("$2::int * INTERVAL '1 minute'");
    expect(sql).toContain("actor_id = $3");
    expect(params).toEqual(["consecutive_sign_in_denials", 60, "actor-1"]);
  });

  it("builds query with ipAddress condition", async () => {
    const pool = mockPool();
    await isDuplicate(pool, "consecutive_sign_in_denials", 60, {
      ipAddress: "10.0.0.1",
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("ip_address = $3");
    expect(params).toEqual(["consecutive_sign_in_denials", 60, "10.0.0.1"]);
  });

  it("builds query with jsonPath condition", async () => {
    const pool = mockPool();
    await isDuplicate(pool, "bridge_abuse", 60, {
      jsonPath: ["aiceId", "aice.example.com"],
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("summary->>$3 = $4");
    expect(params).toEqual(["bridge_abuse", 60, "aiceId", "aice.example.com"]);
  });

  it("combines actorId and ipAddress conditions", async () => {
    const pool = mockPool();
    await isDuplicate(pool, "session_ip_mismatch", 60, {
      actorId: "actor-1",
      ipAddress: "10.0.0.1",
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("actor_id = $3");
    expect(sql).toContain("ip_address = $4");
    expect(params).toEqual(["session_ip_mismatch", 60, "actor-1", "10.0.0.1"]);
  });

  it("passes cooldown as a parameterized value", async () => {
    const pool = mockPool();
    await isDuplicate(pool, "bridge_abuse", 30, { actorId: "actor-1" });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("$2::int * INTERVAL '1 minute'");
    expect(params[1]).toBe(30);
  });
});
