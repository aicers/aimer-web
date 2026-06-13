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

describe("seedRealStoryJobs — bilingual eager seeding (#580)", () => {
  // Build a PoolClient stub whose responses are driven by the SQL text. `maxGen`
  // is what the per-(model pair) `MAX(generation)` probe returns (null → no
  // existing variant); `capped` is the at-cap-variant probe result.
  function makeClient(opts: {
    actionable: Array<{
      customer_id: string;
      story_id: string;
      status: string;
    }>;
    maxGen?: number | null;
    capped?: Array<{ lang: string; model_name: string; model: string }>;
    calls: Array<{ sql: string; params?: readonly unknown[] }>;
  }) {
    return {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        opts.calls.push({ sql, params });
        if (sql.includes("FROM story_analysis_state s")) {
          return { rows: opts.actionable };
        }
        if (sql.includes("SELECT MAX(generation) AS max_gen")) {
          return { rows: [{ max_gen: opts.maxGen ?? null }] };
        }
        if (
          sql.includes("SELECT lang, model_name, model FROM story_analysis_job")
        ) {
          return { rows: opts.capped ?? [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
  }

  // Seed INSERTs now carry the target generation as the 7th bind ($7), so the
  // missing translation pairs with the live English canonical instead of a
  // fixed generation 1 (#580).
  function seedInsertsAt(
    calls: Array<{ sql: string; params?: readonly unknown[] }>,
  ) {
    return calls.filter(
      (c) =>
        c.sql.includes("INSERT INTO story_analysis_job") &&
        c.sql.includes("'queued', $7, FALSE"),
    );
  }

  it("seeds the full eager set (English + user language) for a dirty story with no jobs", async () => {
    // A dirty state with no jobs (e.g. dry-run rows purged) must seed the whole
    // eager set — English canonical + the app user-language translate variant —
    // at generation 1 (MAX(generation) is NULL → target 1), not just one
    // variant. DEFAULT_LOCALE defaults to "ko", so EAGER_LANGS = [ENGLISH,
    // KOREAN].
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg) => {
      warns.push(String(msg));
    });
    const client = makeClient({
      actionable: [{ customer_id: "c1", story_id: "1001", status: "dirty" }],
      maxGen: null,
      calls,
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    expect(warns.some((w) => w.includes("story_max_generation_reached"))).toBe(
      false,
    );
    const seedInserts = seedInsertsAt(calls);
    const seededLangs = seedInserts.map((c) => c.params?.[2]);
    expect(seededLangs).toContain("ENGLISH");
    expect(seededLangs).toContain("KOREAN");
    // Target generation = 1 for a story with no existing variant.
    for (const ins of seedInserts) expect(ins.params?.[6]).toBe(1);
    // State row is flipped back to ready in the same iteration.
    const stateUpdate = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_state") &&
        c.sql.includes("status = 'ready'"),
    );
    expect(stateUpdate).toBeDefined();
  });

  it("aligns an existing English + missing/lagging user-language pair to one target generation when dirty", async () => {
    // The regression the per-row `+1` bump caused: English canonical at gen 3
    // with no (or a lagging) Korean variant. A `+1` bump would move English to
    // 4 while seeding/leaving Korean at a lower generation, pinning the Korean
    // translation to a superseded English canonical. The pair must instead
    // align to a SINGLE target (MAX + 1 = 4): the eager uniform UPDATE writes
    // `generation = $7` and the missing Korean is seeded at the same target.
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({
      actionable: [{ customer_id: "c1", story_id: "3003", status: "dirty" }],
      maxGen: 3,
      calls,
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    // The eager-model uniform bump sets a single target generation ($7 = 4),
    // scoped to the row's model pair — not a per-row `generation + 1`.
    const eagerBump = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_job") &&
        c.sql.includes("generation = $7") &&
        c.sql.includes("model_name = $4 AND model = $5"),
    );
    expect(eagerBump).toBeDefined();
    expect(eagerBump?.params?.[6]).toBe(4);
    // Missing eager variants are seeded at the SAME target generation (4), so
    // the Korean translate job derives from the bumped English canonical.
    const seedInserts = seedInsertsAt(calls);
    expect(seedInserts.length).toBeGreaterThan(0);
    for (const ins of seedInserts) expect(ins.params?.[6]).toBe(4);
  });

  it("warns per capped variant and caps the shared target at MAX_GENERATION", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg) => {
      warns.push(String(msg));
    });
    const client = makeClient({
      actionable: [{ customer_id: "c1", story_id: "2002", status: "dirty" }],
      // English already at the cap (50). MAX + 1 would overshoot, so the shared
      // target is clamped to MAX_GENERATION.
      maxGen: 50,
      capped: [{ lang: "ENGLISH", model_name: "openai", model: "gpt-4o" }],
      calls,
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    // The capped English variant is surfaced (per-variant warn).
    expect(warns.some((w) => w.includes("story_max_generation_reached"))).toBe(
      true,
    );
    // The eager uniform bump still fires with the target clamped to 50.
    const eagerBump = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_job") &&
        c.sql.includes("generation = $7") &&
        c.sql.includes("model_name = $4 AND model = $5"),
    );
    expect(eagerBump).toBeDefined();
    expect(eagerBump?.params?.[6]).toBe(50);
    // Legacy other-model variants keep the independent `+1` refresh.
    const otherModelBump = calls.find(
      (c) =>
        c.sql.includes("UPDATE story_analysis_job") &&
        c.sql.includes("generation = generation + 1") &&
        c.sql.includes("NOT (model_name = $4 AND model = $5)"),
    );
    expect(otherModelBump).toBeDefined();
  });

  it("seeds a missing user-language variant at the canonical's generation for a ready story", async () => {
    // The bilingual-rollout migration path: an existing single-language story is
    // `ready` (not dirty) with English at gen 5 and no Korean job. The missing
    // Korean must seed at the EXISTING canonical generation (5), not a fixed 1,
    // or it would derive from a superseded English generation.
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({
      actionable: [{ customer_id: "c1", story_id: "4004", status: "ready" }],
      maxGen: 5,
      calls,
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal PoolClient stub
    await seedRealStoryJobs(client as any, 100);
    warnSpy.mockRestore();

    const seedInserts = seedInsertsAt(calls);
    expect(seedInserts.length).toBeGreaterThan(0);
    for (const ins of seedInserts) expect(ins.params?.[6]).toBe(5);
  });
});
