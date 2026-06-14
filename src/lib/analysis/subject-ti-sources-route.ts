// Shared request handlers for the per-subject TI source selection (RFC 0003
// F2, #598). The permission split crosses auth contexts exactly like
// `customer-default-model-route.ts` — System Administrator authorizes in the
// ADMIN context (any customer), Analyst in the GENERAL context (assigned
// customers only) — but both surfaces drive the SAME service/guard
// (`*SubjectTiSources`). These handlers are parameterized by `authContext`
// so the admin route (`/api/admin/customers/[id]/ti-sources`) and the
// analyst route (`/api/subjects/[id]/ti-sources`) share one implementation.
//
// v1 is customer-only: the service `assertCustomerExists` 404s a group
// subject-id rather than mis-authorizing it through the customer path.

import "server-only";

import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import type { AuthenticatedRequest } from "@/lib/auth/guards";
import { verifyCsrf, verifyOrigin } from "@/lib/auth/guards";
import { getAuthPool, withTransaction } from "@/lib/db/client";
import {
  clearSubjectTiSources,
  readSubjectTiSources,
  setSubjectTiSources,
  toCatalogDto,
} from "./ti-sources";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract the subject/customer id path segment (the segment after `subjects`
 * or `customers`), or `null` if it is not a UUID.
 */
export function extractSubjectId(req: NextRequest): string | null {
  const segments = req.nextUrl.pathname.split("/");
  let idx = segments.indexOf("subjects");
  if (idx === -1) idx = segments.indexOf("customers");
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

export async function handleGetSubjectTiSources(
  req: NextRequest,
  auth: AuthenticatedRequest,
  authContext: "general" | "admin",
): Promise<Response> {
  const subjectId = extractSubjectId(req);
  if (!subjectId) {
    return Response.json({ error: "Invalid subject ID" }, { status: 400 });
  }
  try {
    const view = await withTransaction(getAuthPool(), (client) =>
      readSubjectTiSources(client, authContext, auth.accountId, subjectId),
    );
    // Effective selection + the selectable catalog as the public DTO (every
    // source with its enabled/disabled state), so a narrowed subject's missing
    // coverage is visible and no descriptor internals leak.
    return Response.json({
      ...view,
      enabledSourceIds: view.effective,
      catalog: toCatalogDto(view.effective),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handlePutSubjectTiSources(
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

  const subjectId = extractSubjectId(req);
  if (!subjectId) {
    return Response.json({ error: "Invalid subject ID" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const { enabledSourceIds, changed } = await withTransaction(
      getAuthPool(),
      (client) =>
        setSubjectTiSources(
          client,
          authContext,
          auth.accountId,
          subjectId,
          raw,
          { ipAddress: auth.meta.ipAddress, sid: auth.sessionId },
        ),
    );
    return Response.json({ enabledSourceIds, changed });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDeleteSubjectTiSources(
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

  const subjectId = extractSubjectId(req);
  if (!subjectId) {
    return Response.json({ error: "Invalid subject ID" }, { status: 400 });
  }

  try {
    const { cleared } = await withTransaction(getAuthPool(), (client) =>
      clearSubjectTiSources(client, authContext, auth.accountId, subjectId, {
        ipAddress: auth.meta.ipAddress,
        sid: auth.sessionId,
      }),
    );
    return Response.json({ cleared });
  } catch (err) {
    return errorResponse(err);
  }
}
