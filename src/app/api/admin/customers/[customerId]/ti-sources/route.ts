// Admin surface for a customer's per-subject TI source selection (RFC 0003
// F2, #598). System Administrator only (admin context), any customer. The
// Analyst-facing counterpart lives at `/api/subjects/[subjectId]/ti-sources`
// (general context). Both delegate to the same shared handlers / service guard.

import type { NextRequest } from "next/server";
import {
  handleDeleteSubjectTiSources,
  handleGetSubjectTiSources,
  handlePutSubjectTiSources,
} from "@/lib/analysis/subject-ti-sources-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleGetSubjectTiSources(req, auth, "admin"),
  { ctx: "admin" },
);

export const PUT = withAuth(
  (req: NextRequest, auth) => handlePutSubjectTiSources(req, auth, "admin"),
  { ctx: "admin" },
);

export const DELETE = withAuth(
  (req: NextRequest, auth) => handleDeleteSubjectTiSources(req, auth, "admin"),
  { ctx: "admin" },
);
