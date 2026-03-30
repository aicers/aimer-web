import type { NextRequest } from "next/server";
import { auditLog } from "../audit";
import { getAuthPool, query } from "../db/client";
import { type AuthContext, clearAllAuthCookies } from "./cookies";
import { verifyJwtForLogout } from "./jwt";

/**
 * Cross-check the other auth context's cookie. If it belongs to a
 * different account, revoke all sessions for the previous account
 * and clear all cookies. Same-account sessions are preserved.
 *
 * Returns the previous account ID if revocation occurred, or null.
 */
export async function enforceSameAccount(
  request: NextRequest,
  currentAccountId: string,
  currentCtx: AuthContext,
  meta: { ipAddress: string },
): Promise<string | null> {
  // Determine which cookie to cross-check
  const otherCookieName = currentCtx === "general" ? "at_admin" : "at";
  const otherToken = request.cookies.get(otherCookieName)?.value;

  if (!otherToken) {
    return null;
  }

  const otherClaims = await verifyJwtForLogout(otherToken);
  if (!otherClaims) {
    // Signature failed — treat as no valid existing session
    return null;
  }

  // Same account — sessions coexist
  if (otherClaims.sub === currentAccountId) {
    return null;
  }

  // Different account — revoke all sessions for the previous account
  const previousAccountId = otherClaims.sub;
  const pool = getAuthPool();

  await query(
    pool,
    `UPDATE sessions SET revoked = true WHERE account_id = $1 AND revoked = false`,
    [previousAccountId],
  );

  await clearAllAuthCookies();

  void auditLog({
    actorId: currentAccountId,
    authContext: currentCtx,
    action: "session.cross_context_mismatch",
    targetType: "account",
    targetId: previousAccountId,
    details: { reason: "account_switched" },
    ipAddress: meta.ipAddress,
  });

  return previousAccountId;
}
