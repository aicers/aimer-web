// RFC 0002 Phase 0 (#294) — hook-failure response policy (decision 2).
//
// Locks in the rule that an auth-DB hook failure after a successful
// customer-DB commit is swallowed: the ingest's success response is
// preserved, the error is logged at `error` level, and reconciliation
// (Phase 1+) is left to seed/forward-patch on the next pass.
// Returning a non-2xx here would tell the sender to retry an ingest
// whose JTI is already consumed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  applyBaselineIngestHook,
  applyStoryIngestHook,
  applyWindowReplaceEnvelopeHook,
  applyWindowReplaceStoryHook,
} = await import("../ingest-hooks");

const CUSTOMER_ID = "00000000-0000-0000-0000-000000000001";

function failingPool() {
  return {
    query: vi.fn().mockRejectedValue(new Error("auth db is down")),
    connect: vi.fn().mockRejectedValue(new Error("auth db is down")),
  } as unknown as import("pg").Pool;
}

describe("analysis ingest hooks — failure swallowing (decision 2)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("applyBaselineIngestHook logs and resolves when the auth pool query fails", async () => {
    await expect(
      applyBaselineIngestHook(failingPool(), {
        customerId: CUSTOMER_ID,
        acceptedEvents: [
          {
            eventTime: new Date("2026-05-27T10:00:00Z"),
            receivedAt: new Date("2026-05-27T10:00:01Z"),
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `baseline_ingest failed for customer ${CUSTOMER_ID}`,
      ),
    );
  });

  it("applyStoryIngestHook logs and resolves when the connection fails", async () => {
    await expect(
      applyStoryIngestHook(failingPool(), {
        customerId: CUSTOMER_ID,
        arrivals: [
          { storyId: "1001", arrivedAt: new Date("2026-05-27T10:00:00Z") },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `story_ingest failed for customer ${CUSTOMER_ID}`,
      ),
    );
  });

  it("applyWindowReplaceEnvelopeHook logs and resolves when the connection fails", async () => {
    await expect(
      applyWindowReplaceEnvelopeHook(failingPool(), failingPool(), {
        customerId: CUSTOMER_ID,
        from: new Date("2026-05-27T00:00:00Z"),
        to: new Date("2026-05-27T01:00:00Z"),
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `refresh_window_envelope failed for customer ${CUSTOMER_ID}`,
      ),
    );
  });

  it("applyWindowReplaceStoryHook logs and resolves when the connection fails", async () => {
    await expect(
      applyWindowReplaceStoryHook(failingPool(), {
        customerId: CUSTOMER_ID,
        mutatedStoryIds: ["1001"],
        storyVersionSurvivors: [
          { storyId: "1001", surviving: 0, lastReceivedAt: null },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `refresh_window_story failed for customer ${CUSTOMER_ID}`,
      ),
    );
  });

  it("empty inputs are no-ops without touching the pool", async () => {
    const pool = failingPool();
    await applyBaselineIngestHook(pool, {
      customerId: CUSTOMER_ID,
      acceptedEvents: [],
    });
    await applyStoryIngestHook(pool, {
      customerId: CUSTOMER_ID,
      arrivals: [],
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
