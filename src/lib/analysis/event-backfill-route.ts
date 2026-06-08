// Shared request handlers for the operator-triggered event-leaf
// re-analysis backfill (#470).
//
// Like the #473 default-model surface, the permission split crosses auth
// contexts — System Administrator authorizes in the ADMIN context (any
// customer), Analyst in the GENERAL context (assigned customers only) —
// but both drive ONE implementation. These handlers are parameterized by
// `authContext` so the admin route (`/api/admin/customers/[id]/event-backfill`)
// and the customer route (`/api/customers/[id]/analysis/event-backfill`)
// share one set of handlers and differ only in their `withAuth` / CSRF
// context.
//
// Authorization reuses the `customer-default-model:read|write` keys: the
// backfill is launched from the #473 model-change flow and is gated to
// exactly the same two roles (Admin any customer; Analyst assigned), so no
// new permission is introduced.

import "server-only";

import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import type { AuthenticatedRequest } from "@/lib/auth/guards";
import { verifyCsrf, verifyOrigin } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { resolveDefaultModel } from "./default-model";
import {
  DEFAULT_WINDOW_DAYS,
  previewBackfill,
  resolveScopeWindow,
  type TargetVariant,
} from "./event-leaf-backfill";
import {
  createRun,
  getRun,
  listRuns,
  requestCancel,
} from "./event-leaf-backfill-store";
import { computeEventLeafDrain } from "./event-leaf-drain";

type AuthContext = "general" | "admin";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERM_READ = "customer-default-model:read";
const PERM_WRITE = "customer-default-model:write";

const ALLOWED_LANGS = new Set(["KOREAN", "ENGLISH"]);
const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";

/** Largest accepted recent-window so a run can never silently span history. */
const MAX_WINDOW_DAYS = 365;

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("customers");
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const id = segments[idx + 1];
  return UUID_RE.test(id) ? id : null;
}

function extractRunId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  const idx = segments.indexOf("runs");
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

async function authorize(
  authContext: AuthContext,
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

/** Parse a positive integer query/body value, or `fallback` when absent. */
function parsePositiveInt(
  raw: unknown,
  fallback: number | null,
): number | null {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new HttpError("invalid_integer", 400);
  }
  return n;
}

/**
 * Resolve the target variant for a backfill request. Lang defaults to the
 * deployment default; the `(model_name, model)` pair defaults to the
 * customer's effective default model (#473 resolver) — i.e. the new
 * default after a model change, the natural backfill target.
 */
async function resolveTarget(
  customerId: string,
  langRaw: string | null,
  modelNameRaw: string | null,
  modelRaw: string | null,
): Promise<TargetVariant> {
  const lang = langRaw ?? DEFAULT_LANG;
  if (!ALLOWED_LANGS.has(lang)) {
    throw new HttpError("lang must be one of KOREAN, ENGLISH", 400);
  }
  if (modelNameRaw && modelRaw) {
    return { lang, modelName: modelNameRaw, model: modelRaw };
  }
  const def = await resolveDefaultModel(customerId);
  return { lang, modelName: def.modelName, model: def.model };
}

function resolveWindowDays(raw: unknown): number {
  const days =
    parsePositiveInt(raw, DEFAULT_WINDOW_DAYS) ?? DEFAULT_WINDOW_DAYS;
  if (days <= 0) throw new HttpError("window_days must be positive", 400);
  if (days > MAX_WINDOW_DAYS) {
    throw new HttpError(`window_days exceeds ${MAX_WINDOW_DAYS}`, 400);
  }
  return days;
}

// ---------------------------------------------------------------------------
// GET preview — counts over the §2 universe (required pre-run confirm)
// ---------------------------------------------------------------------------

export async function handlePreview(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    await authorize(authContext, auth.accountId, customerId, "read");
    const sp = req.nextUrl.searchParams;
    const windowDays = resolveWindowDays(sp.get("window_days"));
    const maxItems = parsePositiveInt(sp.get("max_items"), null);
    const target = await resolveTarget(
      customerId,
      sp.get("lang"),
      sp.get("model_name"),
      sp.get("model"),
    );
    const window = resolveScopeWindow(windowDays, getCurrentTimestamp());
    const customerPool = getCustomerRuntimePool(customerId);
    const counts = await previewBackfill(
      customerPool,
      window,
      target,
      maxItems,
    );
    return Response.json({
      customerId,
      target,
      windowDays,
      windowStart: window.windowStart.toISOString(),
      windowEnd: window.windowEnd.toISOString(),
      maxItems,
      counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST create — required explicit confirmation, launches background run
// ---------------------------------------------------------------------------

export async function handleCreateRun(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    await authorize(authContext, auth.accountId, customerId, "write");
    // Required explicit confirmation (Scope §7): the run does not proceed
    // without it. The client shows the preview counts, then confirms.
    if (body.confirm !== true) {
      throw new HttpError("confirmation_required", 400);
    }
    const windowDays = resolveWindowDays(body.windowDays);
    const maxItems = parsePositiveInt(body.maxItems, null);
    const target = await resolveTarget(
      customerId,
      typeof body.lang === "string" ? body.lang : null,
      typeof body.modelName === "string" ? body.modelName : null,
      typeof body.model === "string" ? body.model : null,
    );
    const window = resolveScopeWindow(windowDays, getCurrentTimestamp());
    const customerPool = getCustomerRuntimePool(customerId);
    const authClient = await getAuthPool().connect();
    try {
      const { run, created } = await createRun(authClient, customerPool, {
        customerId,
        target,
        windowDays,
        window,
        maxItems,
        createdBy: auth.accountId,
      });
      return Response.json({ run, created }, { status: created ? 201 : 200 });
    } finally {
      authClient.release();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// GET runs — recent runs for the customer (UI progress / history)
// ---------------------------------------------------------------------------

export async function handleListRuns(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    await authorize(authContext, auth.accountId, customerId, "read");
    const runs = await listRuns(getAuthPool(), customerId);
    return Response.json({ runs });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// GET runs/[runId] — single run status / progress
// ---------------------------------------------------------------------------

export async function handleGetRun(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
): Promise<Response> {
  const customerId = extractCustomerId(req);
  const runId = extractRunId(req);
  if (!customerId || !runId) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  try {
    await authorize(authContext, auth.accountId, customerId, "read");
    const run = await getRun(getAuthPool(), customerId, runId);
    if (!run) {
      return Response.json({ error: "run_not_found" }, { status: 404 });
    }
    return Response.json({ run });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST runs/[runId]/cancel — cooperative cancel
// ---------------------------------------------------------------------------

export async function handleCancelRun(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
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
  const runId = extractRunId(req);
  if (!customerId || !runId) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  try {
    await authorize(authContext, auth.accountId, customerId, "write");
    const run = await requestCancel(
      getAuthPool(),
      customerId,
      runId,
      getCurrentTimestamp().toISOString(),
    );
    if (!run) {
      // Either it does not exist or it is already terminal.
      return Response.json({ error: "not_cancellable" }, { status: 409 });
    }
    return Response.json({ run });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// GET drain — scope-addressable drain-completion signal (#469 gate)
// ---------------------------------------------------------------------------

export async function handleDrain(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: AuthContext,
): Promise<Response> {
  const customerId = extractCustomerId(req);
  if (!customerId) {
    return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  }
  try {
    await authorize(authContext, auth.accountId, customerId, "read");
    const sp = req.nextUrl.searchParams;
    const windowDays = resolveWindowDays(sp.get("window_days"));
    const target = await resolveTarget(
      customerId,
      sp.get("lang"),
      sp.get("model_name"),
      sp.get("model"),
    );
    const customerPool = getCustomerRuntimePool(customerId);
    const status = await computeEventLeafDrain(customerPool, {
      customerId,
      windowDays,
      target,
    });
    return Response.json(status);
  } catch (err) {
    return errorResponse(err);
  }
}
