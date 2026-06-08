// Admin surface for the operator-triggered event-leaf re-analysis backfill
// (#470). System Administrator only (admin context), any customer. The
// Analyst-facing counterpart lives at
// `/api/customers/[customerId]/analysis/event-backfill` (general context).
// Both delegate to the same shared handlers.
//
//   GET  — list recent runs for the customer
//   POST — create a run (requires explicit `confirm: true`)

import type { NextRequest } from "next/server";
import {
  handleCreateRun,
  handleListRuns,
} from "@/lib/analysis/event-backfill-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleListRuns(req, auth, "admin"),
  { ctx: "admin" },
);

export const POST = withAuth(
  (req: NextRequest, auth) => handleCreateRun(req, auth, "admin"),
  { ctx: "admin" },
);
