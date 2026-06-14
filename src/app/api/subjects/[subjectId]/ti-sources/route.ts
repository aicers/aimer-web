// Analyst-facing surface for a subject's per-subject TI source selection
// (RFC 0003 F2, #598). General context — an Analyst may read/change it only
// for customers they are assigned to (the `ti-sources:*` grant flows through
// the analyst-assignment union in `authorizeGeneral`). Manager and User hold
// neither grant and are denied. v1 is customer-only: a group subject-id 404s
// rather than being mis-authorized (group surface lands with #542). The admin
// counterpart (System Administrator, any customer) lives at
// `/api/admin/customers/[customerId]/ti-sources`. Both delegate to the same
// shared handlers / service guard.

import type { NextRequest } from "next/server";
import {
  handleDeleteSubjectTiSources,
  handleGetSubjectTiSources,
  handlePutSubjectTiSources,
} from "@/lib/analysis/subject-ti-sources-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleGetSubjectTiSources(req, auth, "general"),
  { ctx: "general" },
);

export const PUT = withAuth(
  (req: NextRequest, auth) => handlePutSubjectTiSources(req, auth, "general"),
  { ctx: "general" },
);

export const DELETE = withAuth(
  (req: NextRequest, auth) =>
    handleDeleteSubjectTiSources(req, auth, "general"),
  { ctx: "general" },
);
