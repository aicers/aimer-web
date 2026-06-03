// Server-side scope resolver for cross-customer overview pages (WS1, #390 /
// parent #386).
//
// The client provider (`use-customer-context`) derives the active scope from
// the URL for the sidebar control, but the canonical-redirect and bridge
// short-circuit contracts in #390/#386 are server obligations: a shared or
// hand-typed link (`?scope=c2,c1`, duplicate/inaccessible ids, `garbage`,
// uppercase `ALL`, …) must be rewritten to its canonical sorted form at the
// page level, and bridge sessions — which cannot read cross-customer report
// surfaces — must be short-circuited off the SERVER session fields
// (`bridgeAiceId` / `bridgeCustomerIds`), not the client `me`.
//
// This loader performs that resolution. It mirrors the auth preamble of the
// analysis page loaders (cookie → JWT → session) and reads the ambient
// accessible-customer set the scope normalizes against. Rendering the
// cross-customer overview under the resolved scope is WS2 (#391); WS1 only
// delivers the scope reaching the page, so the loader returns the resolved
// scope (or a redirect target) rather than any report content.

import "server-only";

import { listAccessibleCustomers } from "@/lib/auth/authorization";
import { getAuthCookie } from "@/lib/auth/cookies";
import { verifyJwtFull } from "@/lib/auth/jwt";
import { getSessionPolicy } from "@/lib/auth/session-policy";
import { validateSession } from "@/lib/auth/session-validator";
import { getAuthPool, withTransaction } from "@/lib/db/client";

import { mergeQuery } from "./query";
import {
  type NormalizedScope,
  normalizeScope,
  SCOPE_PARAM,
  scopeRedirectTarget,
} from "./scope";

export type ScopePageOutcome =
  | { kind: "unauthorized" }
  /** Bridge session — cross-customer surfaces are N/A; short-circuit. */
  | { kind: "bridge" }
  /** The URL is not canonical; redirect to this same-origin path+query. */
  | { kind: "redirect"; target: string }
  /** Scope resolved; rendering the overview under it is WS2 (#391). */
  | { kind: "ok"; scope: NormalizedScope };

export interface ScopePageInput {
  /** The page's own path (e.g. `/en/reports`) — the redirect base. */
  pathname: string;
  /** The page's `searchParams` (Next passes a plain object after await). */
  searchParams: Record<string, string | string[] | undefined>;
}

/** Collapse a possibly-repeated search param to its first scalar value. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Build a `URLSearchParams` from Next's plain `searchParams` object. */
function toUrlSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value != null) {
      params.set(key, value);
    }
  }
  return params;
}

export async function loadScopePage(
  input: ScopePageInput,
): Promise<ScopePageOutcome> {
  const token = await getAuthCookie("general");
  if (!token) return { kind: "unauthorized" };
  let claims: Awaited<ReturnType<typeof verifyJwtFull>>;
  try {
    claims = await verifyJwtFull(token, "general");
  } catch {
    return { kind: "unauthorized" };
  }

  const authPool = getAuthPool();

  let bridgeAiceId: string | null = null;
  let bridgeCustomerIds: string[] | null = null;
  try {
    const policy = await getSessionPolicy();
    const session = await validateSession(authPool, claims.sid, policy.general);
    bridgeAiceId = session.bridgeAiceId;
    bridgeCustomerIds = session.bridgeCustomerIds;
  } catch {
    return { kind: "unauthorized" };
  }

  // Bridge sessions are pinned to a fixed bridge scope and cannot read
  // cross-customer surfaces — short-circuit off the server session fields
  // (#390), independent of any `?scope=` value.
  if (bridgeAiceId !== null || bridgeCustomerIds !== null) {
    return { kind: "bridge" };
  }

  // Ambient accessible-customer set the scope normalizes against. Not a
  // bridge session here, so no bridge scope is passed.
  const customers = await withTransaction(authPool, (client) =>
    listAccessibleCustomers(client, claims.sub, null),
  );
  const accessibleIds = customers.map((c) => c.id);

  const raw = firstParam(input.searchParams[SCOPE_PARAM]);
  const target = scopeRedirectTarget(raw, accessibleIds);
  if (target !== null) {
    // Rewrite only the scope param, preserving the report-variant params
    // already on the URL (parent query-preservation contract).
    const qs = mergeQuery(toUrlSearchParams(input.searchParams), {
      [SCOPE_PARAM]: target,
    });
    return {
      kind: "redirect",
      target: qs ? `${input.pathname}?${qs}` : input.pathname,
    };
  }

  return { kind: "ok", scope: normalizeScope(raw, accessibleIds) };
}
