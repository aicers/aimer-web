import { ClientError } from "graphql-request";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { __testables, seedRealStoryJobs } from "../story-worker";

const { classifyAimerError, checkRedactionPolicyVersion, jobStoryLockId2 } =
  __testables;

function fakeClientError(status: number): ClientError {
  // ClientError shape: { response: { status, errors } }
  return new ClientError(
    {
      status,
      errors: status >= 400 && status < 500 ? [{ message: "bad" }] : undefined,
      headers: new Headers(),
      data: null,
    } as unknown as ClientError["response"],
    { query: "x" },
  );
}

describe("classifyAimerError", () => {
  it("5xx → retryable aimer_5xx", () => {
    expect(classifyAimerError(fakeClientError(503))).toEqual({
      code: "aimer_5xx",
      retryable: true,
    });
  });

  it("4xx → fatal aimer_4xx", () => {
    expect(classifyAimerError(fakeClientError(401))).toEqual({
      code: "aimer_4xx",
      retryable: false,
    });
  });

  it("plain Error → retryable aimer_unavailable", () => {
    expect(classifyAimerError(new Error("ECONNREFUSED"))).toEqual({
      code: "aimer_unavailable",
      retryable: true,
    });
  });
});

describe("checkRedactionPolicyVersion", () => {
  it("returns ok when all members share the same non-empty version", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
      ]),
    ).toEqual({ kind: "ok", version: "engine:1.0|ranges:abc" });
  });

  it("returns missing on empty string version", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "" } as any,
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("returns mismatched when members disagree", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:xyz" } as any,
      ]),
    ).toEqual({ kind: "mismatched" });
  });

  it("returns missing for zero members", () => {
    expect(checkRedactionPolicyVersion([])).toEqual({ kind: "missing" });
  });

  it("returns missing when any member's version is null", () => {
    // pg's typed row reader can surface null if a future migration
    // relaxes the NOT NULL constraint on `redaction_policy_version`.
    // The precondition must reject this defensively rather than
    // returning ok with a `null` version (which would then be passed
    // to the result-row INSERT and recorded as a missing policy
    // stamp).
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: null } as any,
      ]),
    ).toEqual({ kind: "missing" });
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: null } as any,
      ]),
    ).toEqual({ kind: "missing" });
  });
});

describe("jobStoryLockId2", () => {
  it("is deterministic for the same input", () => {
    expect(jobStoryLockId2("12345")).toBe(jobStoryLockId2("12345"));
  });
  it("returns a non-zero positive integer", () => {
    expect(jobStoryLockId2("12345")).toBeGreaterThan(0);
  });
});

describe("seedRealStoryJobs — dirty state with no default-variant job", () => {
  // A dirty state row can carry no default-variant job at all (e.g.
  // the dry-run job rows were purged while the state survived). The
  // seeding pass must insert generation 1 in that case rather than
  // treating it as max-generation-reached. The reviewer's Round-4
  // scenario.
  it("inserts generation 1 when a dirty state has no default-variant job", async () => {
    const actionable = [
      {
        customer_id: "c1",
        story_id: "1001",
        status: "dirty" as const,
      },
    ];
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg) => {
      warns.push(String(msg));
    });
    const client = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        // First call: SELECT actionable rows.
        if (sql.includes("FROM story_analysis_state s")) {
          return { rows: actionable };
        }
        // Probe for existing default-variant job: return empty.
        if (
          sql.includes("SELECT generation FROM story_analysis_job") &&
          sql.includes("customer_id = $1")
        ) {
          return { rows: [] };
        }
        // INSERT or UPDATE: shape doesn't matter, just acknowledge.
        return { rows: [], rowCount: 1 };
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    // The dirty/no-job case must NOT emit story_max_generation_reached.
    expect(warns.some((w) => w.includes("story_max_generation_reached"))).toBe(
      false,
    );
    // It MUST issue an INSERT for the dirty row (the seed-generation-1 path).
    const insertCall = calls.find(
      (c) =>
        c.sql.includes("INSERT INTO story_analysis_job") &&
        c.sql.includes("'queued', 1, FALSE"),
    );
    expect(insertCall).toBeDefined();
    // It MUST flip the state row back to ready in the same iteration.
    const stateUpdate = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_state") &&
        c.sql.includes("status = 'ready'"),
    );
    expect(stateUpdate).toBeDefined();
  });

  it("logs story_max_generation_reached only when an existing job sits at the cap", async () => {
    const actionable = [
      {
        customer_id: "c1",
        story_id: "2002",
        status: "dirty" as const,
      },
    ];
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg) => {
      warns.push(String(msg));
    });
    const client = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM story_analysis_state s")) {
          return { rows: actionable };
        }
        if (
          sql.includes("SELECT generation FROM story_analysis_job") &&
          sql.includes("customer_id = $1")
        ) {
          // Default `ANALYSIS_MAX_GENERATION` is 50; report a row at
          // the cap.
          return { rows: [{ generation: 50 }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    expect(warns.some((w) => w.includes("story_max_generation_reached"))).toBe(
      true,
    );
    // No INSERT and no bump UPDATE should fire — only the state-row
    // flip back to ready.
    const insertCall = calls.find(
      (c) =>
        c.sql.includes("INSERT INTO story_analysis_job") &&
        c.sql.includes("'queued', 1, FALSE"),
    );
    expect(insertCall).toBeUndefined();
    const bumpCall = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_job") &&
        c.sql.includes("generation = generation + 1"),
    );
    expect(bumpCall).toBeUndefined();
  });
});
