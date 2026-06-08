// Analyst (general-context) surface for the report-variant refresh (#469).
// Assigned customers only. The System Administrator counterpart lives at
// `/api/admin/customers/[customerId]/report-refresh`. Both delegate to the
// same shared handlers.

import type { NextRequest } from "next/server";
import {
  handleCreateRun,
  handleListRuns,
} from "@/lib/analysis/report-refresh-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleListRuns(req, auth, "general"),
  { ctx: "general" },
);

export const POST = withAuth(
  (req: NextRequest, auth) => handleCreateRun(req, auth, "general"),
  { ctx: "general" },
);
