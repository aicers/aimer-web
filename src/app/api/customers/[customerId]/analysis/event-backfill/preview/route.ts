// Analyst (general-context) preview for the event-leaf backfill (#470).

import type { NextRequest } from "next/server";
import { handlePreview } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handlePreview(req, auth, "general"),
  { ctx: "general" },
);
