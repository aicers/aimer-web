// Admin single-run status + per-variant outcomes for the report-variant
// refresh (#469).

import type { NextRequest } from "next/server";
import { handleGetRun } from "@/lib/analysis/report-refresh-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleGetRun(req, auth, "admin"),
  { ctx: "admin" },
);
