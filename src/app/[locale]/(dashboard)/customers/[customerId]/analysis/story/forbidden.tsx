// WS3 (#392) — 403 boundary for the Threat Stories list. Rendered when the
// list page calls `forbidden()` (member without `analyses:read`, or an
// in-scope bridge session). Stamps a real 403. The story detail subtree
// collapses denial to 404, so it never reaches this boundary.
export default function ThreatStoriesForbidden() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Threat Stories</h1>
      </header>
      <div
        role="alert"
        aria-label="forbidden-banner"
        data-testid="forbidden-banner"
        className="rounded border border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        You do not have permission to view threat stories for this customer
        (403). Ask a customer administrator to grant the{" "}
        <code>analyses:read</code> permission.
      </div>
    </div>
  );
}
