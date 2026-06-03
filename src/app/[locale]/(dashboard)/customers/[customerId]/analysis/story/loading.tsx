// WS3 (#392) — loading state for the Threat Stories list, shown while the
// server component awaits the keyset query.
export default function ThreatStoriesLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Threat Stories</h1>
      </header>
      <div
        role="status"
        aria-label="loading"
        data-testid="stories-loading"
        className="rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      >
        Loading threat stories…
      </div>
    </div>
  );
}
