// RFC 0004 (#503) — central route builder for the analysis surface.
//
// The entire analysis surface (pages AND API) lives under
// `/subjects/[subjectId]/...`. For a customer, its `subjectId` is its
// customer UUID (a customer is a `kind='customer'` subject sharing the
// PK), so callers pass the customer id unchanged. `/customers/[id]/...`
// stays as an inbound-compatibility alias (see `src/proxy.ts`), but
// NO freshly generated link may target it — always build links here so
// they emit `/subjects/...` and do not drift back to `/customers`.

/** Locale-prefixed analysis **page** routes (client navigation / links). */
export const subjectPages = {
  /** Subject analysis hub. */
  hub: (locale: string, subjectId: string) =>
    `/${locale}/subjects/${subjectId}`,
  reportsIndex: (locale: string, subjectId: string) =>
    `/${locale}/subjects/${subjectId}/analysis/reports`,
  report: (
    locale: string,
    subjectId: string,
    period: string,
    bucketDate: string,
  ) =>
    `/${locale}/subjects/${subjectId}/analysis/reports/${period}/${bucketDate}`,
  /**
   * Per-period calendar / date-jump (#505). Range-bounded by a viewport
   * search param the caller appends (`?month=YYYY-MM` for DAILY,
   * `?year=YYYY` for WEEKLY/MONTHLY). No calendar route for LIVE.
   */
  reportCalendar: (locale: string, subjectId: string, period: string) =>
    `/${locale}/subjects/${subjectId}/analysis/reports/${period}/calendar`,
  storyIndex: (locale: string, subjectId: string) =>
    `/${locale}/subjects/${subjectId}/analysis/story`,
  story: (locale: string, subjectId: string, storyId: string) =>
    `/${locale}/subjects/${subjectId}/analysis/story/${storyId}`,
  events: (locale: string, subjectId: string) =>
    `/${locale}/subjects/${subjectId}/analysis/events`,
  eventAnalysis: (
    locale: string,
    subjectId: string,
    aiceId: string,
    eventKey: string,
  ) =>
    `/${locale}/subjects/${subjectId}/aice/${aiceId}/events/${eventKey}/analysis`,
} as const;

/** Non-locale-prefixed analysis **API** routes (server-side `fetch`). */
export const subjectApi = {
  reportSummary: (subjectId: string, period: string, bucketDate: string) =>
    `/api/subjects/${subjectId}/analysis/report/${period}/${bucketDate}/summary`,
  reportRegenerate: (subjectId: string, period: string, bucketDate: string) =>
    `/api/subjects/${subjectId}/analysis/report/${period}/${bucketDate}/regenerate`,
  reportLanguageStatus: (
    subjectId: string,
    period: string,
    bucketDate: string,
  ) =>
    `/api/subjects/${subjectId}/analysis/report/${period}/${bucketDate}/language-status`,
  storySummary: (subjectId: string, storyId: string) =>
    `/api/subjects/${subjectId}/analysis/story/${storyId}/summary`,
  storyRegenerate: (subjectId: string, storyId: string) =>
    `/api/subjects/${subjectId}/analysis/story/${storyId}/regenerate`,
  reanalyze: (subjectId: string) =>
    `/api/subjects/${subjectId}/analysis/reanalyze`,
  eventBackfill: (subjectId: string) =>
    `/api/subjects/${subjectId}/analysis/event-backfill`,
  reportRefresh: (subjectId: string) =>
    `/api/subjects/${subjectId}/analysis/report-refresh`,
  defaultModel: (subjectId: string) =>
    `/api/subjects/${subjectId}/analysis/default-model`,
  eventRegenerate: (subjectId: string, aiceId: string, eventKey: string) =>
    `/api/subjects/${subjectId}/aice/${aiceId}/events/${eventKey}/regenerate`,
} as const;
