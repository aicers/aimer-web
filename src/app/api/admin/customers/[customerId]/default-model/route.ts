// Admin surface for a customer's per-customer default analysis model
// (#473). System Administrator only (admin context), any customer. The
// Analyst-facing counterpart lives at
// `/api/subjects/[subjectId]/analysis/default-model` (general context).
// Both delegate to the same shared handlers / service guard.

import type { NextRequest } from "next/server";
import {
  handleDeleteCustomerDefaultModel,
  handleGetCustomerDefaultModel,
  handlePutCustomerDefaultModel,
} from "@/lib/analysis/customer-default-model-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) => handleGetCustomerDefaultModel(req, auth, "admin"),
  { ctx: "admin" },
);

export const PUT = withAuth(
  (req: NextRequest, auth) => handlePutCustomerDefaultModel(req, auth, "admin"),
  { ctx: "admin" },
);

export const DELETE = withAuth(
  (req: NextRequest, auth) =>
    handleDeleteCustomerDefaultModel(req, auth, "admin"),
  { ctx: "admin" },
);
