// RFC 0002 Phase 0 (#326) — mockable time seam for the analysis-job
// worker.
//
// The worker's readiness / settle / quiet-window predicates are all SQL
// `NOW()` calls. To make them deterministic from tests, every NOW() in
// time-dependent paths is replaced with a `$n::timestamptz` bind
// parameter sourced from `getCurrentTimestamp()` in JS. Production
// returns `new Date()`; tests mock this module via `vi.mock` to inject
// a controllable clock.
//
// `runAnalysisJobTickOnce` captures `nowIso` once at the top of the
// tick and threads it through to every sub-call so all rows touched by
// one tick share the same "now" — eliminating intra-tick drift bugs
// that would otherwise creep in if each call site read the clock
// independently.

import "server-only";

export function getCurrentTimestamp(): Date {
  return new Date();
}
