// Analyst (general-context) cancel for an event-leaf backfill run (#470).

import type { NextRequest } from "next/server";
import { handleCancelRun } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const POST = withAuth(
  (req: NextRequest, auth) => handleCancelRun(req, auth, "general"),
  { ctx: "general" },
);
