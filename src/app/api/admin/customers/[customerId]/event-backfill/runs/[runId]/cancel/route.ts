// Admin cancel for an event-leaf backfill run (#470). Sets the cooperative
// cancel flag the worker observes between events.

import type { NextRequest } from "next/server";
import { handleCancelRun } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const POST = withAuth(
  (req: NextRequest, auth) => handleCancelRun(req, auth, "admin"),
  { ctx: "admin" },
);
