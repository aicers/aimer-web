import { describe, expect, it } from "vitest";
import { windowReplacePayloadSchema } from "../window-replace";

const baseEvent = {
  event_key: "1",
  event_time: "2026-01-02T01:00:00Z",
  kind: "dns",
  category: null,
  primary_asset: null,
  raw_score: 0.5,
  selector_tags: [],
  raw_event: {},
  score_window_context: {
    kind_cohort_window: {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    },
    kind_cohort_size: 1,
    baseline_rank_snapshot: 0.5,
  },
  window_signals: {},
  scoring_weights_snapshot: {},
};

const baseStory = {
  story_id: "100",
  story_version: "v1",
  kind: "auto_correlated" as const,
  time_window: { start: "2026-01-02T01:00:00Z", end: "2026-01-02T01:30:00Z" },
  summary_payload: {},
  members: [],
};

describe("windowReplacePayloadSchema — baseline", () => {
  const baseBody = {
    external_key: "ext-1",
    window: {
      kind: "baseline_event" as const,
      from: "2026-01-02T00:00:00Z",
      to: "2026-01-02T02:00:00Z",
    },
    baseline_version: "bv-1",
    events: [baseEvent],
  };

  it("accepts a minimal valid baseline body", () => {
    expect(windowReplacePayloadSchema.safeParse(baseBody).success).toBe(true);
  });

  it("accepts an empty events array (window clear)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({ ...baseBody, events: [] }).success,
    ).toBe(true);
  });

  it("rejects event_time before window.from", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        events: [{ ...baseEvent, event_time: "2026-01-01T23:59:59Z" }],
      }).success,
    ).toBe(false);
  });

  it("rejects event_time equal to window.to (exclusive upper bound)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        events: [{ ...baseEvent, event_time: "2026-01-02T02:00:00Z" }],
      }).success,
    ).toBe(false);
  });

  it("accepts event_time equal to window.from (inclusive lower bound)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        events: [{ ...baseEvent, event_time: "2026-01-02T00:00:00Z" }],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate (baseline_version, event_key) within events", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        events: [baseEvent, baseEvent],
      }).success,
    ).toBe(false);
  });
});

describe("windowReplacePayloadSchema — story", () => {
  const baseBody = {
    external_key: "ext-1",
    window: {
      kind: "story" as const,
      from: "2026-01-02T00:00:00Z",
      to: "2026-01-02T02:00:00Z",
    },
    stories: [baseStory],
  };

  it("accepts a minimal valid story body", () => {
    expect(windowReplacePayloadSchema.safeParse(baseBody).success).toBe(true);
  });

  it("accepts an empty stories array (window clear)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({ ...baseBody, stories: [] })
        .success,
    ).toBe(true);
  });

  it("rejects stories whose kind is analyst_curated", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [{ ...baseStory, kind: "analyst_curated" }],
      }).success,
    ).toBe(false);
  });

  it("rejects time_window.start before window.from", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [
          {
            ...baseStory,
            time_window: {
              start: "2026-01-01T23:59:59Z",
              end: "2026-01-02T01:00:00Z",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects time_window.start equal to window.to (exclusive upper)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [
          {
            ...baseStory,
            time_window: {
              start: "2026-01-02T02:00:00Z",
              end: "2026-01-02T03:00:00Z",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a story whose end extends past window.to (start-time assignment)", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [
          {
            ...baseStory,
            time_window: {
              start: "2026-01-02T01:00:00Z",
              end: "2026-01-02T05:00:00Z",
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate (story_id, story_version) across stories", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [baseStory, baseStory],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate (story_id, story_version, member_event_key) within members", () => {
    expect(
      windowReplacePayloadSchema.safeParse({
        ...baseBody,
        stories: [
          {
            ...baseStory,
            members: [
              { event_key: "1", role: "primary", event: {} },
              { event_key: "1", role: "context", event: {} },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
