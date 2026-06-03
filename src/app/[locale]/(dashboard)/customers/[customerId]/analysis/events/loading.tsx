// WS3 (#392) — loading state for the Suspicious Events list, shown while
// the server component awaits the keyset query.
export default function SuspiciousEventsLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          Suspicious Events
        </h1>
      </header>
      <div
        role="status"
        aria-label="loading"
        data-testid="events-loading"
        className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      >
        Loading suspicious events…
      </div>
    </div>
  );
}
