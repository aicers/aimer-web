// Analyst cost-preview for the report-variant refresh (#469): per-outcome
// counts over the scope, counts only — no monetary figure.

import type { NextRequest } from "next/server";
import { handlePreview } from "@/lib/analysis/report-refresh-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handlePreview(req, auth, "general"),
  { ctx: "general" },
);
