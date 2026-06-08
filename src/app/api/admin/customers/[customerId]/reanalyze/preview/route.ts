// Admin cost-preview for the story-leaf re-analysis backfill (#466).
// Read-only: returns the target scope and per-category counts so the
// operator can confirm before enqueueing.

import type { NextRequest } from "next/server";
import { handleBackfillPreview } from "@/lib/analysis/story-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleBackfillPreview(req, auth, "admin"),
  { ctx: "admin" },
);
