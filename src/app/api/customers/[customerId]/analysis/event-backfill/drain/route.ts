// Analyst (general-context) drain-completion signal for the event-leaf
// backfill (#470 Scope §6).

import type { NextRequest } from "next/server";
import { handleDrain } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleDrain(req, auth, "general"),
  { ctx: "general" },
);
