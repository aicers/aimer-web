// Admin surface for the operator-triggered report-variant refresh (#469).
// System Administrator only (admin context), any customer. The Analyst-facing
// counterpart lives at `/api/customers/[customerId]/analysis/report-refresh`.
// Both delegate to the same shared handlers.
//
//   GET  — list recent refresh runs for the customer
//   POST — run a refresh (requires explicit `confirm: true`)

import type { NextRequest } from "next/server";
import {
  handleCreateRun,
  handleListRuns,
} from "@/lib/analysis/report-refresh-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleListRuns(req, auth, "admin"),
  { ctx: "admin" },
);

export const POST = withAuth(
  (req: NextRequest, auth) => handleCreateRun(req, auth, "admin"),
  { ctx: "admin" },
);
