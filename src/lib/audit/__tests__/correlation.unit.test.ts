import { describe, expect, it } from "vitest";
import { getCorrelationId, withCorrelationId } from "../correlation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("correlation ID", () => {
  it("returns undefined when no context is set", () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it("provides a UUID v4 inside withCorrelationId", async () => {
    let captured: string | undefined;
    await withCorrelationId(() => {
      captured = getCorrelationId();
    });
    expect(captured).toMatch(UUID_RE);
  });

  it("generates a unique ID per invocation", async () => {
    const ids: (string | undefined)[] = [];
    await withCorrelationId(() => {
      ids.push(getCorrelationId());
    });
    await withCorrelationId(() => {
      ids.push(getCorrelationId());
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("does not leak into the outer scope", async () => {
    await withCorrelationId(() => {});
    expect(getCorrelationId()).toBeUndefined();
  });

  it("supports nested contexts (inner wins)", async () => {
    let outer: string | undefined;
    let inner: string | undefined;
    await withCorrelationId(async () => {
      outer = getCorrelationId();
      await withCorrelationId(() => {
        inner = getCorrelationId();
      });
      // after inner completes, outer is restored
      expect(getCorrelationId()).toBe(outer);
    });
    expect(outer).toMatch(UUID_RE);
    expect(inner).toMatch(UUID_RE);
    expect(outer).not.toBe(inner);
  });
});
