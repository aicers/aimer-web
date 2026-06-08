// Analyst-facing surface for the story-leaf re-analysis backfill (#466).
// General context, assigned customers only. POST enqueues the coalescing
// backfill (confirm-gated). The admin counterpart lives at
// `/api/admin/customers/[customerId]/reanalyze`; both delegate to the same
// shared handlers / service guard.

import type { NextRequest } from "next/server";
import { handleBackfillRun } from "@/lib/analysis/story-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const POST = withAuth(
  (req: NextRequest, auth) => handleBackfillRun(req, auth, "general"),
  { ctx: "general" },
);
