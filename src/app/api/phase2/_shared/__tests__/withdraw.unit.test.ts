import { describe, expect, it } from "vitest";
import { withdrawPayloadSchema } from "../withdraw";

describe("withdrawPayloadSchema", () => {
  it("accepts a minimal mixed-kind payload", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "v42",
          event_keys: ["12345", "67890"],
        },
        { kind: "story", story_id: "1001", story_version: "v7" },
        { kind: "policy_event", run_id: "2002", event_keys: ["12345"] },
        { kind: "policy_run", run_id: "2003" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty withdrawals array", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty event_keys array on baseline_event", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "baseline_event", baseline_version: "v1", event_keys: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate (baseline_version, event_key) within one item", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "v1",
          event_keys: ["1", "1"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate (baseline_version, event_key) across items", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "baseline_event", baseline_version: "v1", event_keys: ["1"] },
        { kind: "baseline_event", baseline_version: "v1", event_keys: ["1"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the same event_key under different baseline_version values", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "baseline_event", baseline_version: "v1", event_keys: ["1"] },
        { kind: "baseline_event", baseline_version: "v2", event_keys: ["1"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate (story_id, story_version) across items", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "story", story_id: "1", story_version: "v1" },
        { kind: "story", story_id: "1", story_version: "v1" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate (run_id, event_key) within one policy_event item", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "policy_event", run_id: "10", event_keys: ["5", "5"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate run_id across policy_run items", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        { kind: "policy_run", run_id: "10" },
        { kind: "policy_run", run_id: "10" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive bigint story_id", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [{ kind: "story", story_id: "0", story_version: "v1" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric event_key", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "v1",
          event_keys: ["abc"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects leading-zero event_key (would alias '01' and '1' to one DB row)", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [
        {
          kind: "baseline_event",
          baseline_version: "v1",
          event_keys: ["01"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects leading-zero story_id", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [{ kind: "story", story_id: "01", story_version: "v1" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects leading-zero run_id on policy_run", () => {
    const result = withdrawPayloadSchema.safeParse({
      external_key: "ext-1",
      withdrawals: [{ kind: "policy_run", run_id: "010" }],
    });
    expect(result.success).toBe(false);
  });
});
