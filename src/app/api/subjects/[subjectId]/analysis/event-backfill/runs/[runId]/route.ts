// Analyst (general-context) single-run status for the event-leaf backfill
// (#470).

import type { NextRequest } from "next/server";
import { handleGetRun } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleGetRun(req, auth, "general"),
  { ctx: "general" },
);
