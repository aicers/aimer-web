import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool } from "@/lib/db/client";
import {
  computeCombinedRecentEventVolume,
  estimateMonthlyCost,
  GENERATION_CADENCE,
} from "@/lib/groups/cost-preview";
import { validateGroupMembers } from "@/lib/groups/member-validation";

// POST /api/groups/preview — informational creation-time cost preview.
//
// Auth/body mirror `POST /api/groups`, but the body is only the cost-relevant
// subset { memberIds, tz? }. Runs the SAME shared front-door validation as
// create (annotate mode: over-cap → `overMemberCap: true`, tz divergence →
// `recommendedTz` hint, neither 400s) and returns RESULT FIGURES ONLY. It
// writes nothing — no createGroup, audit, or provisioning — and is the single
// data source for the preview surface (#512); figures are never recomputed
// client-side.
//
// The three computed figures (combinedRecentEventVolume, estimatedMonthlyTokens,
// estimatedMonthlyCostUsd) are nullable: present when computed, `null` when
// skipped (over-cap) — never `0`. No calculation method or coefficient crosses
// this boundary.
export const POST = withAuth(
  async (req: NextRequest, auth) => {
    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "general",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;

    const pool = getAuthPool();
    const client = await pool.connect();
    try {
      const validation = await validateGroupMembers(
        client,
        auth.accountId,
        body,
        "annotate",
      );
      if (!validation.ok) return validation.response;
      const {
        memberIds,
        memberCount,
        maxMembers,
        overMemberCap,
        recommendedTz,
      } = validation.value;

      // The three computed figures are nullable: when the group is over-cap it
      // cannot be created, so there is no point paying the cross-DB reads —
      // skip them and return `null` (never `0`, which would read as "free").
      let combinedRecentEventVolume: number | null = null;
      let estimatedMonthlyTokens: number | null = null;
      let estimatedMonthlyCostUsd: number | null = null;
      if (!overMemberCap) {
        combinedRecentEventVolume =
          await computeCombinedRecentEventVolume(memberIds);
        const est = estimateMonthlyCost(memberCount, combinedRecentEventVolume);
        estimatedMonthlyTokens = est.estimatedMonthlyTokens;
        estimatedMonthlyCostUsd = est.estimatedMonthlyCostUsd;
      }

      return Response.json(
        {
          memberCount,
          maxMembers,
          overMemberCap,
          combinedRecentEventVolume,
          generationCadence: GENERATION_CADENCE,
          estimatedMonthlyTokens,
          estimatedMonthlyCostUsd,
          // tz divergence hint: present only when members differ and no tz was
          // supplied. The cost figures are tz-independent, so preview does not
          // block on it.
          ...(recommendedTz ? { recommendedTz } : {}),
        },
        { status: 200 },
      );
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
  },
  { ctx: "general" },
);
