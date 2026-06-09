// Analyst-facing drain-completion signal for the story-leaf re-analysis
// backfill (#466 Scope §6). Read-only: reports whether the in-scope story
// leaves are re-analyzed under the target model. #469 (report refresh) gates
// on this.

import type { NextRequest } from "next/server";
import { handleBackfillStatus } from "@/lib/analysis/story-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleBackfillStatus(req, auth, "general"),
  { ctx: "general" },
);
