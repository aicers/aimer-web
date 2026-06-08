// Admin preview for the event-leaf backfill (#470) — the required pre-run
// cost preview (counts/scope only, no monetary figure). See the shared
// handler and the general-context twin under
// `/api/customers/[customerId]/analysis/event-backfill/preview`.

import type { NextRequest } from "next/server";
import { handlePreview } from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handlePreview(req, auth, "admin"),
  { ctx: "admin" },
);
