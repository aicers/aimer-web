// Shared request handlers for the operator-triggered report-variant refresh
// (#469).
//
// Like the #466/#470 leaf-backfill surfaces, the permission split crosses
// auth contexts — System Administrator authorizes in the ADMIN context (any
// customer), Analyst in the GENERAL context (assigned customers only) — but
// both drive ONE implementation. These handlers are parameterized by
// `authContext` so the admin route
// (`/api/admin/customers/[id]/report-refresh`) and the analyst route
// (`/api/subjects/[id]/analysis/report-refresh`) share one set of handlers
// and differ only in their `withAuth` / CSRF context.
//
// Authorization reuses the `customer-default-model:read|write` keys: the
// refresh is launched from the #473 model-change flow and is gated to
// exactly the same two roles, so no new permission is introduced.

import "server-only";

import type { NextRequest } from "next/server";
import { auditLog } from "@/lib/audit";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import type { AuthenticatedRequest } from "@/lib/auth/guards";
import { verifyCsrf, verifyOrigin } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import { resolveDefaultModel } from "./default-model";
import type { TargetVariant } from "./event-leaf-backfill";
import type { PeriodicPeriod } from "./report-input-builder";
import {
  ALL_PERIODS,
  DEFAULT_WINDOW_DAYS,
  evaluateCandidates,
  executeReportRefresh,
  MAX_WINDOW_DAYS,
  planRefresh,
  type RefreshScope,
} from "./report-refresh";
import {
  getRun,
  getRunItems,
  listRuns,
  recordRun,
} from "./report-refresh-store";

type AuthContext = "general" | "admin";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERM_READ = "customer-default-model:read";
const PERM_WRITE = "customer-default-model:write";

const ALLOWED_LANGS = new Set(["KOREAN", "ENGLISH"]);
const DEFAULT_LANG = process.env.ANALYSIS_DEFAULT_LANG ?? "ENGLISH";

const PERIOD_SET = new Set<PeriodicPeriod>(ALL_PERIODS);

function extractCustomerId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  let idx = segments.indexOf("subjects");
  if (idx === -1) idx = segments.indexOf("customers");
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

function resolveWindowDays(raw: unknown): number {
  const days =
    parsePositiveInt(raw, DEFAULT_WINDOW_DAYS) ?? DEFAULT_WINDOW_DAYS;
  if (days <= 0) throw new HttpError("window_days must be positive", 400);
  if (days > MAX_WINDOW_DAYS) {
    throw new HttpError(`window_days exceeds ${MAX_WINDOW_DAYS}`, 400);
  }
  return days;
}

/**
 * Parse the optional `periods` axis. A comma-separated subset of
 * LIVE/DAILY/WEEKLY/MONTHLY; absent / empty → all periods. Any unknown token
 * is a 400 so a typo can never silently narrow the scope.
 */
function resolvePeriods(raw: unknown): PeriodicPeriod[] {
  if (raw == null || raw === "") return [...ALL_PERIODS];
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (tokens.length === 0) return [...ALL_PERIODS];
  const out: PeriodicPeriod[] = [];
  for (const tok of tokens) {
    if (!PERIOD_SET.has(tok as PeriodicPeriod)) {
      throw new HttpError("invalid_period", 400);
    }
    if (!out.includes(tok as PeriodicPeriod)) out.push(tok as PeriodicPeriod);
  }
  return out;
}

function resolveLang(raw: unknown): string {
  const lang = typeof raw === "string" && raw ? raw : DEFAULT_LANG;
  if (!ALLOWED_LANGS.has(lang)) {
    throw new HttpError("lang must be one of KOREAN, ENGLISH", 400);
  }
  return lang;
}

/**
 * The refresh target is ALWAYS the customer's resolved default model (the
 * #473 model-change target) — a caller-supplied model pair is never honoured,
 * matching the leaf-backfill create/preview contract. Only `lang` is
 * operator-addressable.
 */
async function resolveTarget(
  customerId: string,
  langRaw: unknown,
): Promise<TargetVariant> {
  const lang = resolveLang(langRaw);
  const def = await resolveDefaultModel(customerId);
  return { lang, modelName: def.modelName, model: def.model };
}

function scopeFrom(
  customerId: string,
  windowDays: number,
  periods: PeriodicPeriod[],
  tz: string | null,
  maxVariants: number | null,
): RefreshScope {
  return { customerId, windowDays, periods, tz, maxVariants };
}

function enqueueWindow(
  windowDays: number,
  now: Date,
): {
  windowStart: Date;
  windowEnd: Date;
} {
  return {
    windowEnd: now,
    windowStart: new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------------------
// GET preview — per-outcome counts over the scope (required pre-run confirm)
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
    const periods = resolvePeriods(sp.get("periods"));
    const tz = sp.get("tz");
    const maxVariants = parsePositiveInt(sp.get("max_variants"), null);
    const target = await resolveTarget(customerId, sp.get("lang"));
    const scope = scopeFrom(customerId, windowDays, periods, tz, maxVariants);
    const now = getCurrentTimestamp();
    const customerPool = getCustomerRuntimePool(customerId);
    const evals = await evaluateCandidates(
      getAuthPool(),
      customerPool,
      scope,
      target,
      now.toISOString(),
    );
    const plan = planRefresh(evals, maxVariants);
    const win = enqueueWindow(windowDays, now);
    return Response.json({
      customerId,
      target,
      windowDays,
      periods,
      tz,
      maxVariants,
      windowStart: win.windowStart.toISOString(),
      windowEnd: win.windowEnd.toISOString(),
      counts: plan.counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST create — required explicit confirmation, synchronous refresh
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
    const periods = resolvePeriods(body.periods);
    const tz = typeof body.tz === "string" && body.tz ? body.tz : null;
    const maxVariants = parsePositiveInt(body.maxVariants, null);
    const target = await resolveTarget(customerId, body.lang);
    const scope = scopeFrom(customerId, windowDays, periods, tz, maxVariants);
    const now = getCurrentTimestamp();
    const customerPool = getCustomerRuntimePool(customerId);

    const authClient = await getAuthPool().connect();
    try {
      await authClient.query("BEGIN");
      const exec = await executeReportRefresh(
        authClient,
        customerPool,
        scope,
        target,
        auth.accountId,
        now,
      );
      const win = enqueueWindow(windowDays, now);
      const run = await recordRun(authClient, {
        scope,
        target,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        counts: exec.counts,
        variants: exec.variants,
        createdBy: auth.accountId,
        now,
      });
      await authClient.query("COMMIT");
      void auditLog({
        actorId: auth.accountId,
        authContext,
        action: "report_refresh.enqueued",
        targetType: "periodic_report_job",
        targetId: customerId,
        customerId,
        sid: auth.sessionId,
        details: {
          scope: {
            customerId,
            windowDays,
            periods,
            tz,
            maxVariants,
            target,
          },
          counts: exec.counts,
        },
      });
      return Response.json({ run }, { status: 201 });
    } catch (err) {
      await authClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      authClient.release();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// GET runs — recent runs for the customer (UI history)
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
// GET runs/[runId] — single run + its per-variant outcome rows
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
    const items = await getRunItems(getAuthPool(), runId);
    return Response.json({ run, items });
  } catch (err) {
    return errorResponse(err);
  }
}
