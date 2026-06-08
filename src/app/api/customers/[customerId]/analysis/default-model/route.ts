// Analyst-facing surface for a customer's per-customer default analysis
// model (#473). General context — an Analyst may read/change it only for
// customers they are assigned to (the `customer-default-model:*` grant
// flows through the analyst-assignment union in `authorizeGeneral`).
// Manager and User hold neither grant and are denied. The admin
// counterpart (System Administrator, any customer) lives at
// `/api/admin/customers/[customerId]/default-model`. Both delegate to the
// same shared handlers / service guard.

import type { NextRequest } from "next/server";
import {
  handleDeleteCustomerDefaultModel,
  handleGetCustomerDefaultModel,
  handlePutCustomerDefaultModel,
} from "@/lib/analysis/customer-default-model-route";
import { withAuth } from "@/lib/auth/guards";

export const GET = withAuth(
  (req: NextRequest, auth) =>
    handleGetCustomerDefaultModel(req, auth, "general"),
  { ctx: "general" },
);

export const PUT = withAuth(
  (req: NextRequest, auth) =>
    handlePutCustomerDefaultModel(req, auth, "general"),
  { ctx: "general" },
);

export const DELETE = withAuth(
  (req: NextRequest, auth) =>
    handleDeleteCustomerDefaultModel(req, auth, "general"),
  { ctx: "general" },
);
