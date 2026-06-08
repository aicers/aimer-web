// Shared request handlers for the operator-triggered story-leaf
// re-analysis backfill (#466).
//
// The actor set and auth split are IDENTICAL to the per-customer
// default-model control this backfill is launched from (#473): System
// Administrator authorizes in the ADMIN context (any customer), Analyst in
// the GENERAL context (assigned customers only). Both surfaces therefore
// reuse the SAME `customer-default-model:*` permission keys and the same
// cross-context guard shape, parameterized by `authContext` so the admin
// route (`/api/admin/customers/[id]/reanalyze/*`) and the customer route
// (`/api/customers/[id]/analysis/reanalyze/*`) share one implementation.
//
// Endpoints:
//   - GET  …/reanalyze/preview  — cost preview (counts/scope, no writes)
//   - POST …/reanalyze          — confirm-gated enqueue (coalescing)
//   - GET  …/reanalyze/status   — scope-addressable drain-completion signal
//
// The target model is ALWAYS the customer's current effective default
// (`resolveDefaultModel`) — the operator scopes the run (window / cap) but
// never picks an arbitrary target model.

import "server-only";

import type { NextRequest } from "next/server";
import { assertAuthorized } from "../auth/authorization";
import { HttpError } from "../auth/errors";
import type { AuthenticatedRequest } from "../auth/guards";
import { verifyCsrf, verifyOrigin } from "../auth/guards";
import { getAuthPool, withTransaction } from "../db/client";
import { getCurrentTimestamp } from "../instrumentation/time";
import { resolveDefaultModel } from "./default-model";
import { storyDrainToLeafStatus } from "./leaf-drain";
import {
  auditBackfillRun,
  type BackfillScope,
  createBackfillDeps,
  DEFAULT_WINDOW_DAYS,
  getStoryBackfillDrainSignal,
  previewStoryBackfill,
  runStoryBackfill,
  WORKER_LANG,
} from "./story-backfill";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reuse the #473 actor set: Analyst (assigned customers) + System
// Administrator (any customer). Read gates preview/status; write gates the
// enqueue.
const PERM_READ = "customer-default-model:read";
const PERM_WRITE = "customer-default-model:write";

/** Extract the `[customerId]` path segment (the segment after `customers`). */
export function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("customers");
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const id = segments[idx + 1];
  return UUID_RE.test(id) ? id : null;
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.statusCode });
  }
  throw err;
}

async function authorizeBackfill(
  authContext: "general" | "admin",
  accountId: string,
  customerId: string,
  op: "read" | "write",
): Promise<void> {
  const permission = op === "write" ? PERM_WRITE : PERM_READ;
  await withTransaction(getAuthPool(), async (client) => {
    if (authContext === "admin") {
      await assertAuthorized(client, "admin", accountId, permission);
      return;
    }
    await assertAuthorized(client, "general", accountId, permission, {
      customerId,
      operationKind: op,
    });
  });
}

/**
 * Parse `windowDays` from the query string. Absent → the conservative 7-day
 * recent-window default (#466 Scope §3). `windowDays=all` opts into the
 * unbounded all-history scope (never the default). A non-positive / NaN
 * value is a 400.
 */
function parseWindowDays(value: string | null): number | null {
  if (value === null) return DEFAULT_WINDOW_DAYS;
  if (value === "all") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError("windowDays must be a positive integer or 'all'", 400);
  }
  return n;
}

/** Parse the optional per-run `cap`. Absent / empty → unbounded (`null`). */
function parseCap(value: string | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError("cap must be a positive integer", 400);
  }
  return n;
}

async function buildScope(
  customerId: string,
  windowDays: number | null,
  cap: number | null,
): Promise<BackfillScope> {
  const target = await resolveDefaultModel(customerId);
  return {
    customerId,
    modelName: target.modelName,
    model: target.model,
    windowDays,
    cap,
  };
}

export async function handleBackfillPreview(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    await authorizeBackfill(authContext, auth.accountId, customerId, "read");
    const windowDays = parseWindowDays(
      req.nextUrl.searchParams.get("windowDays"),
    );
    const cap = parseCap(req.nextUrl.searchParams.get("cap"));
    const scope = await buildScope(customerId, windowDays, cap);
    const counts = await previewStoryBackfill(scope, createBackfillDeps());
    return Response.json({
      scope: {
        customerId,
        modelName: scope.modelName,
        model: scope.model,
        windowDays,
        cap,
      },
      counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleBackfillStatus(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    await authorizeBackfill(authContext, auth.accountId, customerId, "read");
    const windowDays = parseWindowDays(
      req.nextUrl.searchParams.get("windowDays"),
    );
    const cap = parseCap(req.nextUrl.searchParams.get("cap"));
    const scope = await buildScope(customerId, windowDays, cap);
    const signal = await getStoryBackfillDrainSignal(
      scope,
      createBackfillDeps(),
    );
    // Emit the shared `LeafDrainStatus` (kind / scope / universe /
    // outstanding / sourceUnavailable / drained) at the top level so #469
    // can gate on the story- and event-leaf signals through one shape
    // (#470 Scope §6). The legacy `counts` / `totalLeaves` are retained for
    // the #466 status panel, which #469 ignores.
    const windowEnd = getCurrentTimestamp();
    const windowStart =
      windowDays === null
        ? null
        : new Date(
            windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000,
          ).toISOString();
    const leafStatus = storyDrainToLeafStatus(signal, {
      lang: WORKER_LANG,
      windowStart,
      windowEnd: windowEnd.toISOString(),
    });
    return Response.json({
      ...leafStatus,
      counts: signal.counts,
      totalLeaves: signal.totalLeaves,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleBackfillRun(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const originErr = verifyOrigin(req);
  if (originErr) return originErr;
  const csrfErr = verifyCsrf(req, {
    ctx: authContext,
    sid: auth.sessionId,
    iat: auth.iat,
  });
  if (csrfErr) return csrfErr;

  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (raw ?? {}) as Record<string, unknown>;

  // Required explicit confirmation (#466 Scope §7) — the cost preview must be
  // acknowledged; the run never proceeds without it.
  if (body.confirm !== true) {
    return Response.json({ error: "confirmation_required" }, { status: 400 });
  }

  try {
    await authorizeBackfill(authContext, auth.accountId, customerId, "write");
    const wdRaw = body.windowDays;
    const windowDays = parseWindowDays(
      wdRaw === undefined || wdRaw === null ? null : String(wdRaw),
    );
    const capRaw = body.cap;
    const cap = parseCap(
      capRaw === undefined || capRaw === null ? null : String(capRaw),
    );
    const scope = await buildScope(customerId, windowDays, cap);
    const result = await runStoryBackfill(scope, createBackfillDeps());
    auditBackfillRun(authContext, auth.accountId, result, {
      ipAddress: auth.meta.ipAddress,
      sid: auth.sessionId,
    });
    return Response.json(
      {
        scope: {
          customerId,
          modelName: scope.modelName,
          model: scope.model,
          windowDays,
          cap,
        },
        counts: result.counts,
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
