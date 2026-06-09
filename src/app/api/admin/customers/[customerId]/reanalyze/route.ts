// Admin surface for the story-leaf re-analysis backfill (#466). System
// Administrator only (admin context), any customer. POST enqueues the
// coalescing backfill (confirm-gated). The Analyst-facing counterpart lives
// at `/api/subjects/[subjectId]/analysis/reanalyze`; both delegate to the
// same shared handlers / service guard.

import type { NextRequest } from "next/server";
import { handleBackfillRun } from "@/lib/analysis/story-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const POST = withAuth(
  (req: NextRequest, auth) => handleBackfillRun(req, auth, "admin"),
  { ctx: "admin" },
);
