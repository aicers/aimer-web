// Shared event row title (#552).
//
// Replaces the opaque `Event {event_key}` title on the three event surfaces
// (cross-customer overview / suspicious events, the per-subject event list,
// and the report citations panel) with a meaningful
// `{event time} · {kind display name}` label:
//
//   - the time is rendered through the COMPACT `<Timestamp>` mode (#553), so
//     it matches aice-web-next's breadcrumb time and inherits aimer's
//     account-timezone + hydration handling — it is a React element, not a
//     string, so the label is composed here in JSX rather than via i18n
//     interpolation;
//   - the kind display name comes from the ported, English-only
//     `EVENT_KIND_FRIENDLY_NAMES` map (`HttpThreat` → "HTTP Threat"), shown
//     only when `kind` is non-null;
//   - fallbacks: kind null → time only; `eventTime` absent (defensive) → a
//     static localized `fallbackLabel` (`Event` / `이벤트`), never the raw
//     `event_key`.
//
// Presentational + synchronous, so it composes inside the (server-component)
// surfaces; `<Timestamp>` is the only client island.

import { Timestamp } from "@/components/timestamp";
import { eventKindDisplayName } from "@/lib/events/event-kind-names";

export function EventTitle({
  eventTime,
  kind,
  fallbackLabel,
}: {
  /** Upstream event instant, or `null` to render `fallbackLabel`. */
  eventTime: Date | string | null;
  /** Raw upstream kind (`__typename`), or `null` to render time only. */
  kind: string | null;
  /** Static localized fallback shown when `eventTime` is absent. */
  fallbackLabel: string;
}) {
  if (eventTime === null) {
    return <>{fallbackLabel}</>;
  }
  const displayKind = eventKindDisplayName(kind);
  return (
    <>
      <Timestamp at={eventTime} compact />
      {displayKind !== null ? ` · ${displayKind}` : null}
    </>
  );
}
