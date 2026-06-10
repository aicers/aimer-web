// RFC 0004 (#505) — subject retention provider.
//
// Temporal report navigation (calendar + within-period prev/next) needs a
// single source of truth for "how far back is a report still navigable?".
// That boundary is the subject's retention policy: navigable range ≤
// retained range. This module abstracts the read behind a subject-generic
// provider so the calendar / neighbor loaders stay subject-agnostic — a
// **customer** boundary ships now (derived from `customer_retention_policy`),
// and a **group** boundary (the `D + min(group_policy_days, min_over_members(
// H_c))` rule from #509) can plug in later by adding a provider, without
// re-touching the navigation components.
//
// This is the FIRST retention read in the report-navigation path: the
// retention sweeper consumes `analysis_days` too, but it does not reap
// `periodic_report_state`, so report rows persist regardless of retention.
// The boundary computed here is therefore a *navigation* boundary derived
// from policy, not a guarantee that older rows were deleted.

import "server-only";

import type { Pool } from "pg";
import { getCurrentTimestamp } from "@/lib/instrumentation/time";
import {
  addCalendarDays,
  formatDayInTz,
  type PeriodKind,
} from "./report-bucket-date";

export interface RetentionBoundary {
  /**
   * Oldest navigable bucket-START date (inclusive, `YYYY-MM-DD`), or `null`
   * for unbounded retention (`analysis_days = NULL`). A bucket is navigable
   * iff its bucket-start date ≥ this value; a bucket whose start is earlier
   * is out-of-retention, even if it straddles the boundary.
   */
  oldestNavigableDate: string | null;
  /**
   * Today as a `YYYY-MM-DD` calendar day in the subject's timezone — the
   * future cut-off. A bucket whose start is after this is future-dated and
   * non-navigable. Returned alongside the boundary so every navigation
   * surface shares one clock.
   */
  today: string;
}

export interface SubjectRetentionProvider {
  /**
   * The navigable boundary for `period`. `period` is accepted (and ignored
   * by the customer provider) so a group provider — whose bound can vary by
   * period via member redaction-map retention — slots in without changing
   * callers.
   */
  resolveBoundary(period: PeriodKind): Promise<RetentionBoundary>;
}

/**
 * Apply the explicit boundary-inclusion rule: `boundary = today − analysisDays`
 * (calendar-day subtraction). Exposed for direct unit testing of the rule
 * the acceptance criteria pin down.
 */
export function computeBoundaryDate(
  today: string,
  analysisDays: number,
): string {
  return addCalendarDays(today, -analysisDays);
}

interface PolicyRow {
  timezone: string | null;
  analysis_days: number | null;
}

/**
 * The customer retention provider: a customer's `subjectId` is its customer
 * UUID, so the boundary comes straight from its `customer_retention_policy`
 * (`analysis_days`) read in the subject's timezone (`customers.timezone`).
 * `analysis_days = NULL` — or a missing policy row — means unbounded
 * retention, hence no lower bound.
 */
export function createCustomerRetentionProvider(
  subjectId: string,
  authPool: Pool,
  now: () => Date = getCurrentTimestamp,
): SubjectRetentionProvider {
  return {
    async resolveBoundary(_period: PeriodKind): Promise<RetentionBoundary> {
      const { rows } = await authPool.query<PolicyRow>(
        `SELECT c.timezone, crp.analysis_days
           FROM customers c
           LEFT JOIN customer_retention_policy crp ON crp.customer_id = c.id
          WHERE c.id = $1`,
        [subjectId],
      );
      const tz = rows[0]?.timezone ?? "UTC";
      const analysisDays = rows[0]?.analysis_days ?? null;
      const today = formatDayInTz(now(), tz);
      const oldestNavigableDate =
        analysisDays == null ? null : computeBoundaryDate(today, analysisDays);
      return { oldestNavigableDate, today };
    },
  };
}

/**
 * The B4 group retention bound (in DAYS): `min(group_policy_days,
 * min_over_members(H_c))`, where `group_policy_days` is the group's own
 * `analysis_days` and each `H_c` is a member's `analysis_days` retention
 * horizon. A `null` input is "unbounded" and does NOT constrain the min, so the
 * effective bound is the minimum over all NON-null inputs; when every input is
 * null (group and all members unbounded) the result is `null` — unbounded, no
 * lower bound.
 *
 * This is the SINGLE shared helper the display-time navigation boundary (#513,
 * here) and the write-side reaper (#509) must both consume so the two never
 * diverge — whichever lands first introduces it; the other imports it.
 */
export function computeGroupRetentionBoundDays(
  groupPolicyDays: number | null,
  memberAnalysisDays: ReadonlyArray<number | null>,
): number | null {
  const bounded = [groupPolicyDays, ...memberAnalysisDays].filter(
    (d): d is number => d != null,
  );
  if (bounded.length === 0) return null;
  return Math.min(...bounded);
}

interface GroupTzRow {
  tz: string | null;
  group_days: number | null;
}

/**
 * The group retention provider (#513, B4 read-side). A group's navigable
 * boundary is `today − min(group_policy_days, min_over_members(H_c))`
 * ({@link computeGroupRetentionBoundDays}), read in the GROUP's timezone
 * (`customer_groups.tz`). The group policy comes from `group_retention_policy`;
 * each member horizon from that member's `customer_retention_policy`. A missing
 * group / policy row, or a member without a policy row, is treated as unbounded
 * (NULL) — exactly as the customer provider treats a missing policy.
 *
 * Like the customer provider the bound is period-independent in v1 (the B4
 * formula carries no period term); `period` is accepted and ignored so callers
 * stay subject-generic.
 */
export function createGroupRetentionProvider(
  subjectId: string,
  authPool: Pool,
  now: () => Date = getCurrentTimestamp,
): SubjectRetentionProvider {
  return {
    async resolveBoundary(_period: PeriodKind): Promise<RetentionBoundary> {
      const groupRes = await authPool.query<GroupTzRow>(
        `SELECT g.tz, grp.analysis_days AS group_days
           FROM customer_groups g
           LEFT JOIN group_retention_policy grp ON grp.subject_id = g.id
          WHERE g.id = $1`,
        [subjectId],
      );
      const tz = groupRes.rows[0]?.tz ?? "UTC";
      const groupDays = groupRes.rows[0]?.group_days ?? null;

      const memberRes = await authPool.query<{ analysis_days: number | null }>(
        `SELECT crp.analysis_days
           FROM customer_group_members m
           LEFT JOIN customer_retention_policy crp
             ON crp.customer_id = m.customer_id
          WHERE m.group_id = $1`,
        [subjectId],
      );
      const memberDays = memberRes.rows.map((r) => r.analysis_days);

      const boundDays = computeGroupRetentionBoundDays(groupDays, memberDays);
      const today = formatDayInTz(now(), tz);
      const oldestNavigableDate =
        boundDays == null ? null : computeBoundaryDate(today, boundDays);
      return { oldestNavigableDate, today };
    },
  };
}
