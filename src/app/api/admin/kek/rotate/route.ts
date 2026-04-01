import type { NextRequest } from "next/server";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { rotateAllKeks } from "@/lib/auth/kek-rotation";
import { getAuthPool } from "@/lib/db/client";

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const result = await rotateAllKeks(getAuthPool());

    auth.audit.details = {
      customersRotated: result.customersRotated,
      customersErrored: result.customersErrored,
      customerDeksRewrapped: result.customerDeksRewrapped,
      eventDeksRewrapped: result.eventDeksRewrapped,
      stagingDeksRewrapped: result.stagingDeksRewrapped,
    };

    return Response.json(result);
  },
  {
    ctx: "admin",
    audit: { action: "openbao.kek_rotated", targetType: "system" },
  },
);
