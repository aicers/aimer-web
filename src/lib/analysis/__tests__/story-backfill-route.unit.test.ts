import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAssertAuthorized = vi.fn();
vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
}));

vi.mock("@/lib/auth/guards", () => ({
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
}));

vi.mock("@/lib/analysis/default-model", () => ({
  resolveDefaultModel: vi.fn(async () => ({
    modelName: "openai",
    model: "gpt-5.5",
  })),
}));

const mockPreview = vi.fn();
const mockRun = vi.fn();
const mockDrain = vi.fn();
const mockAudit = vi.fn();
vi.mock("@/lib/analysis/story-backfill", () => ({
  DEFAULT_WINDOW_DAYS: 7,
  WORKER_LANG: "ENGLISH",
  createBackfillDeps: () => ({}),
  previewStoryBackfill: (...a: unknown[]) => mockPreview(...a),
  runStoryBackfill: (...a: unknown[]) => mockRun(...a),
  getStoryBackfillDrainSignal: (...a: unknown[]) => mockDrain(...a),
  auditBackfillRun: (...a: unknown[]) => mockAudit(...a),
}));

import {
  handleBackfillPreview,
  handleBackfillRun,
  handleBackfillStatus,
} from "../story-backfill-route";

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
const auth = {
  accountId: "00000000-0000-0000-0000-000000000099",
  sessionId: "sess-1",
  iat: 1000,
  meta: { ipAddress: "127.0.0.1", userAgent: "test" },
  // biome-ignore lint/suspicious/noExplicitAny: minimal auth stub for tests
} as any;

function req(
  path: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${path}`), init);
}

beforeEach(() => {
  mockAssertAuthorized.mockReset().mockResolvedValue(new Set());
  mockPreview.mockReset();
  mockRun.mockReset();
  mockDrain.mockReset();
  mockAudit.mockReset();
});

describe("handleBackfillPreview", () => {
  it("returns the scope (default 7-day window) and counts", async () => {
    mockPreview.mockResolvedValue({
      seeded: 3,
      requeued: 1,
      coalesced: 2,
      skipped_dirty: 1,
      source_unavailable: 0,
      cap_excluded: 0,
    });
    const res = await handleBackfillPreview(
      req(`/api/admin/customers/${CUSTOMER_ID}/reanalyze/preview`),
      auth,
      "admin",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({
      customerId: CUSTOMER_ID,
      modelName: "openai",
      model: "gpt-5.5",
      windowDays: 7,
      cap: null,
    });
    expect(body.counts.seeded).toBe(3);
  });

  it("honors windowDays=all and a per-run cap", async () => {
    mockPreview.mockResolvedValue({
      seeded: 0,
      requeued: 0,
      coalesced: 0,
      skipped_dirty: 0,
      source_unavailable: 0,
      cap_excluded: 0,
    });
    const res = await handleBackfillPreview(
      req(
        `/api/admin/customers/${CUSTOMER_ID}/reanalyze/preview?windowDays=all&cap=50`,
      ),
      auth,
      "admin",
    );
    const body = await res.json();
    expect(body.scope.windowDays).toBeNull();
    expect(body.scope.cap).toBe(50);
  });

  it("rejects an invalid windowDays with 400", async () => {
    const res = await handleBackfillPreview(
      req(
        `/api/admin/customers/${CUSTOMER_ID}/reanalyze/preview?windowDays=-3`,
      ),
      auth,
      "admin",
    );
    expect(res.status).toBe(400);
  });
});

describe("handleBackfillRun", () => {
  it("refuses to run without explicit confirmation", async () => {
    const res = await handleBackfillRun(
      req(`/api/subjects/${CUSTOMER_ID}/analysis/reanalyze`, {
        method: "POST",
        body: JSON.stringify({ windowDays: 7 }),
      }),
      auth,
      "general",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation_required");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("enqueues and audits when confirmed, returning 202 + counts", async () => {
    mockRun.mockResolvedValue({
      scope: {
        customerId: CUSTOMER_ID,
        modelName: "openai",
        model: "gpt-5.5",
        windowDays: 7,
        cap: null,
      },
      counts: {
        seeded: 5,
        requeued: 0,
        coalesced: 0,
        skipped_dirty: 0,
        source_unavailable: 0,
        cap_excluded: 0,
      },
    });
    const res = await handleBackfillRun(
      req(`/api/subjects/${CUSTOMER_ID}/analysis/reanalyze`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, windowDays: 7 }),
      }),
      auth,
      "general",
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.counts.seeded).toBe(5);
    expect(mockRun).toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalled();
  });
});

describe("handleBackfillStatus", () => {
  it("returns the drain-completion signal", async () => {
    mockDrain.mockResolvedValue({
      scope: {
        customerId: CUSTOMER_ID,
        modelName: "openai",
        model: "gpt-5.5",
        windowDays: 7,
      },
      counts: { source_unavailable: 2 },
      totalLeaves: 4,
      outstanding: 1,
      drained: false,
    });
    const res = await handleBackfillStatus(
      req(`/api/admin/customers/${CUSTOMER_ID}/reanalyze/status`),
      auth,
      "admin",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drained).toBe(false);
    expect(body.outstanding).toBe(1);
    // The shared `LeafDrainStatus` shape (#470 Scope §6) is emitted at the
    // top level so #469 can gate on the story- and event-leaf signals
    // uniformly. `universe` = totalLeaves + source_unavailable.
    expect(body.kind).toBe("story");
    expect(body.universe).toBe(6);
    expect(body.sourceUnavailable).toBe(2);
    expect(body.scope.lang).toBe("ENGLISH");
    expect(body.scope.windowDays).toBe(7);
    expect(typeof body.scope.windowStart).toBe("string");
    expect(typeof body.scope.windowEnd).toBe("string");
    // Legacy fields retained for the #466 status panel.
    expect(body.totalLeaves).toBe(4);
    expect(body.counts.source_unavailable).toBe(2);
  });
});
