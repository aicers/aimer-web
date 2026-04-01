import type { NextRequest } from "next/server";
import { getAuditPool } from "@/lib/db/client";
import { runAllAnalyzers } from "@/lib/detection/analyzers";

/**
 * POST /api/admin/detection/analyze
 *
 * Cron-triggered endpoint that runs all periodic detection analyzers.
 * Protected by a shared secret (DETECTION_CRON_SECRET), not admin auth,
 * since this is a machine-to-machine call.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.DETECTION_CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Detection cron not configured" },
      { status: 503 },
    );
  }

  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const pool = getAuditPool();
    const alertsCreated = await runAllAnalyzers(pool);
    return Response.json({ alertsCreated });
  } catch (err) {
    console.error("[detection] Analysis run failed:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
