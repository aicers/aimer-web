import { type NextRequest, NextResponse } from "next/server";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
import {
  clearConnectionIdCookie,
  setInvitationTokenCookie,
} from "@/lib/auth/cookies";
import { hashToken } from "@/lib/auth/invitations";
import { getAuthPool, query } from "@/lib/db/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  const tokenHash = hashToken(token);
  const pool = getAuthPool();

  const rows = await query<{ id: string }>(
    pool,
    `SELECT id FROM invitations
     WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
    [tokenHash],
  );

  if (rows.length === 0) {
    return NextResponse.redirect(
      new URL("/deny?reason=invitation_expired", canonicalOrigin(request)),
    );
  }

  // Clear stale bridge cookie (conflict prevention), then set invite token
  await clearConnectionIdCookie();
  await setInvitationTokenCookie(token);

  const response = NextResponse.redirect(
    new URL("/api/auth/sign-in?flow=invite", canonicalOrigin(request)),
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
