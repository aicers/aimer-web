// Admin drain-completion signal for the event-leaf backfill (#470 Scope
// §6). Scope-addressable; #469 gates its report-variant refresh on this
// alongside the story-side signal. See the shared handler.

import type { NextRequest } from "next/server";
import { handleDrain } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleDrain(req, auth, "admin"),
  { ctx: "admin" },
);
