import type { NextRequest } from "next/server";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { computeCustomerPolicyVersion } from "@/lib/redaction/customer-policy";
import { PER_ROW_SECONDS } from "@/lib/redaction/feature-flag";
import { countStaleRows } from "@/lib/redaction/stale-scan";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCustomerId(req: NextRequest): string | null {
  // `/api/admin/customers/<id>/redaction-jobs/preview`
  const segments = req.nextUrl.pathname.split("/");
  const id = segments[segments.length - 3];
  if (!id || !UUID_RE.test(id)) return null;
  return id;
}

export const GET = withAuth(
  async (req: NextRequest, auth) => {
    const customerId = extractCustomerId(req);
    if (!customerId) {
      return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    }

    const authPool = getAuthPool();
    const client = await authPool.connect();
    let targetVersion: string;
    try {
      await assertAuthorized(
        client,
        "general",
        auth.accountId,
        "customer-redaction-ranges:read",
        { customerId },
      );
      targetVersion = await computeCustomerPolicyVersion(client, customerId);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    } finally {
      client.release();
    }

    const customerPool = getCustomerRuntimePool(customerId);
    const staleRowCount = await countStaleRows(customerPool, targetVersion);
    const estimatedSeconds = Math.ceil(staleRowCount * PER_ROW_SECONDS);

    return Response.json({
      stale_row_count: staleRowCount,
      estimated_duration_seconds: estimatedSeconds,
      target_policy_version: targetVersion,
    });
  },
  { ctx: "general" },
);
