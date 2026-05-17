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
  score_window_context: { baseline_rank_snapshot: 0.9 },
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
          story_id: 1,
          story_version: "v1",
          kind: "auto_correlated",
          time_window_start: "2026-01-02T03:04:05Z",
          time_window_end: "2026-01-02T03:14:05Z",
          summary_payload: {},
          members: [
            { member_event_key: "10", role: "primary", event: {} },
            { member_event_key: "11", role: "context", event: {} },
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
          story_id: 1,
          story_version: "v1",
          kind: "auto_correlated",
          time_window_start: "2026-01-02T03:04:05Z",
          time_window_end: "2026-01-02T03:14:05Z",
          summary_payload: {},
          members: [{ member_event_key: "10", role: "bystander", event: {} }],
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
        run_id: 100,
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at_source: "2026-01-02T03:14:06Z",
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

  it("rejects status outside the allowed set", () => {
    const result = policyRunSchema.safeParse({
      external_key: "ext-1",
      run: {
        run_id: 100,
        period_start: "2026-01-02T03:04:05Z",
        period_end: "2026-01-02T03:14:05Z",
        created_at_source: "2026-01-02T03:14:06Z",
        baseline_version: "v1",
        policies_fingerprint: "pfp",
        exclusions_fingerprint: "efp",
        status: "draft",
      },
      events: [],
    });
    expect(result.success).toBe(false);
  });
});
