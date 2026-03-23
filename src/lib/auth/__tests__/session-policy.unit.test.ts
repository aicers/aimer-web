import { describe, expect, it } from "vitest";

// Test the floor enforcement logic directly
function enforceFloor(ctx: {
  idle_timeout_minutes: number;
  absolute_timeout_minutes: number;
}) {
  const MIN_IDLE = 5;
  const MIN_ABSOLUTE = 60;
  return {
    idle_timeout_minutes: Math.max(ctx.idle_timeout_minutes, MIN_IDLE),
    absolute_timeout_minutes: Math.max(
      ctx.absolute_timeout_minutes,
      MIN_ABSOLUTE,
    ),
  };
}

describe("session policy floor enforcement", () => {
  it("preserves values above minimum", () => {
    const result = enforceFloor({
      idle_timeout_minutes: 30,
      absolute_timeout_minutes: 480,
    });
    expect(result.idle_timeout_minutes).toBe(30);
    expect(result.absolute_timeout_minutes).toBe(480);
  });

  it("clamps idle below 5 minutes to 5", () => {
    const result = enforceFloor({
      idle_timeout_minutes: 1,
      absolute_timeout_minutes: 480,
    });
    expect(result.idle_timeout_minutes).toBe(5);
  });

  it("clamps absolute below 60 minutes to 60", () => {
    const result = enforceFloor({
      idle_timeout_minutes: 15,
      absolute_timeout_minutes: 30,
    });
    expect(result.absolute_timeout_minutes).toBe(60);
  });

  it("clamps both when both are below minimum", () => {
    const result = enforceFloor({
      idle_timeout_minutes: 0,
      absolute_timeout_minutes: 0,
    });
    expect(result.idle_timeout_minutes).toBe(5);
    expect(result.absolute_timeout_minutes).toBe(60);
  });

  it("preserves exact minimum values", () => {
    const result = enforceFloor({
      idle_timeout_minutes: 5,
      absolute_timeout_minutes: 60,
    });
    expect(result.idle_timeout_minutes).toBe(5);
    expect(result.absolute_timeout_minutes).toBe(60);
  });
});
