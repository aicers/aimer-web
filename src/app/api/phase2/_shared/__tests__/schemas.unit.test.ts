import { describe, expect, it } from "vitest";
import {
  baselineBatchSchema,
  policyRunSchema,
  storyBatchSchema,
} from "../schemas";

const baseEvent = {
  event_key: "12345",
  event_time: "2026-01-02T03:04:05Z",
  kind: "dns",
  category: "recon",
  primary_asset: "host-1",
  raw_score: 0.5,
  selector_tags: ["t1"],
  raw_event: { foo: "bar" },
  score_window_context: {
    kind_cohort_window: {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    },
    kind_cohort_size: 128,
    baseline_rank_snapshot: 0.9,
  },
  window_signals: { s1: 1 },
  asset_context: { peer_event_summary: {} },
  scoring_weights_snapshot: { weights: {} },
};

describe("baselineBatchSchema", () => {
  it("accepts a minimal valid batch", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      source_aice_id: "aice-1",
      baseline_version: "v1",
      events: [baseEvent],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-numeric event_key", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [{ ...baseEvent, event_key: "12.34" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing baseline_version", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      events: [baseEvent],
    });
    expect(result.success).toBe(false);
  });
});

describe("storyBatchSchema", () => {
  it("accepts a story with two members at different roles", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "1",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [
            { event_key: "10", role: "primary", event: {} },
            { event_key: "11", role: "context", event: {} },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown member role", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "1",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [{ event_key: "10", role: "bystander", event: {} }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a story omitting known_ioc_hit and defaults it to false", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "1",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stories[0].known_ioc_hit).toBe(false);
    }
  });

  it("accepts a story with known_ioc_hit=true and round-trips it", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "1",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          known_ioc_hit: true,
          members: [],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stories[0].known_ioc_hit).toBe(true);
    }
  });

  it("rejects a JSON-number story_id (RFC requires stringified BIGINT)", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: 1,
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("policyRunSchema", () => {
  it("accepts a run with two events", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: {
        run_id: "100",
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at: "2026-01-02T03:14:06Z",
        baseline_version: "v1",
        policies_fingerprint: "pfp",
        exclusions_fingerprint: "efp",
        status: "ready",
      },
      events: [
        {
          event_key: "1",
          event_time: "2026-01-02T03:04:05Z",
          kind: "http",
          policy_triage_snapshot: [{ policyId: "p1", score: 0.42 }],
        },
        {
          event_key: "2",
          event_time: "2026-01-02T03:05:05Z",
          kind: "dns",
          policy_triage_snapshot: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a policy_triage_snapshot item missing `score`", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: {
        run_id: "100",
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at: "2026-01-02T03:14:06Z",
        baseline_version: "v1",
        policies_fingerprint: "pfp",
        exclusions_fingerprint: "efp",
        status: "ready",
      },
      events: [
        {
          event_key: "1",
          event_time: "2026-01-02T03:04:05Z",
          kind: "http",
          policy_triage_snapshot: [{ policyId: "p1" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects status outside the allowed set", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: {
        run_id: "100",
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at: "2026-01-02T03:14:06Z",
        baseline_version: "v1",
        policies_fingerprint: "pfp",
        exclusions_fingerprint: "efp",
        status: "draft",
      },
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a JSON-number run_id (RFC requires stringified BIGINT)", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: {
        run_id: 100,
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at: "2026-01-02T03:14:06Z",
        baseline_version: "v1",
        policies_fingerprint: "pfp",
        exclusions_fingerprint: "efp",
        status: "ready",
      },
      events: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("baselineEventSchema score_window_context required fields", () => {
  it("rejects a baseline event missing kind_cohort_window", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [
        {
          ...baseEvent,
          score_window_context: {
            kind_cohort_size: 128,
            baseline_rank_snapshot: 0.9,
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a baseline event missing baseline_rank_snapshot", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [
        {
          ...baseEvent,
          score_window_context: {
            kind_cohort_window: {
              from: "2026-01-01T00:00:00Z",
              to: "2026-01-02T00:00:00Z",
            },
            kind_cohort_size: 128,
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind_cohort_window when sent as a number (RFC requires { from, to })", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [
        {
          ...baseEvent,
          score_window_context: {
            kind_cohort_window: 3600,
            kind_cohort_size: 128,
            baseline_rank_snapshot: 0.9,
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects kind_cohort_window missing the `to` boundary", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [
        {
          ...baseEvent,
          score_window_context: {
            kind_cohort_window: { from: "2026-01-01T00:00:00Z" },
            kind_cohort_size: 128,
            baseline_rank_snapshot: 0.9,
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts extra unknown keys in score_window_context (passthrough)", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [
        {
          ...baseEvent,
          score_window_context: {
            kind_cohort_window: {
              from: "2026-01-01T00:00:00Z",
              to: "2026-01-02T00:00:00Z",
            },
            kind_cohort_size: 128,
            baseline_rank_snapshot: 0.9,
            extra_diagnostic: "ok",
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("stringifiedBigintPositive range enforcement", () => {
  const validRun = {
    run_id: "100",
    period_start: "2026-01-02T03:04:05Z",
    period_end: "2026-01-02T03:14:05Z",
    created_at: "2026-01-02T03:14:06Z",
    baseline_version: "v1",
    policies_fingerprint: "pfp",
    exclusions_fingerprint: "efp",
    status: "ready" as const,
  };

  it("rejects story_id beyond 2^63 - 1 before the DB cast can fail", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "999999999999999999999999",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects story_id <= 0 (BIGSERIAL-derived IDs are positive)", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "0",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts story_id at the BIGINT upper bound (2^63 - 1)", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "9223372036854775807",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects run.replaces beyond 2^63 - 1 before the DB cast can fail", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: { ...validRun, replaces: "999999999999999999999999" },
      events: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("canonical numeric string form (no leading zeros)", () => {
  it("rejects leading-zero event_key (DB casts '01' and '1' to one numeric)", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [{ ...baseEvent, event_key: "01" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts literal '0' as event_key (zero is a valid NUMERIC value)", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [{ ...baseEvent, event_key: "0" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects leading-zero story_id", () => {
    const result = storyBatchSchema.safeParse({
      external_key: "ext-1",
      stories: [
        {
          story_id: "01",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: {
            start: "2026-01-02T03:04:05Z",
            end: "2026-01-02T03:14:05Z",
          },
          summary_payload: {},
          members: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("eventKeyString cap at NUMERIC(39, 0)", () => {
  it("accepts a 39-digit key", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [{ ...baseEvent, event_key: "1".repeat(39) }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 40-digit key (would overflow NUMERIC(39, 0))", () => {
    const result = baselineBatchSchema.safeParse({
      external_key: "ext-1",
      baseline_version: "v1",
      events: [{ ...baseEvent, event_key: "1".repeat(40) }],
    });
    expect(result.success).toBe(false);
  });
});
