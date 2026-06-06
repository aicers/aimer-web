import { type NextRequest, NextResponse } from "next/server";
import { resolveInvitationType } from "@/lib/auth/analyst-invitations";
import { canonicalOrigin } from "@/lib/auth/canonical-origin";
import {
  clearConnectionIdCookie,
  setInvitationTokenCookie,
} from "@/lib/auth/cookies";
import { getAuthPool } from "@/lib/db/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  const pool = getAuthPool();

  // Dual lookup: accept the token if EITHER a member or analyst invitation
  // is pending + unexpired. Both invitation types share the single
  // invitation_token cookie and the same sign-in redirect below.
  const type = await resolveInvitationType(pool, token);

  if (type === "not_found") {
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
