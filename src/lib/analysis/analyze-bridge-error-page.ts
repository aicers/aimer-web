import "server-only";

import {
  ANALYZE_BRIDGE_ERROR_TITLES,
  type AnalyzeBridgeErrorCode,
} from "./analyze-bridge-types";

// Per-code HTTP status. Matches `analyzeErrorResponse`'s mapping for
// every `AnalyzeErrorCode` plus 400 for the bridge-only
// `invalid_analyze_params_token`. Used so the styled error page is
// returned with a semantically meaningful status, even though the
// human-facing surface is an HTML body rather than a JSON envelope.
const ERROR_HTTP_STATUS: Record<AnalyzeBridgeErrorCode, number> = {
  invalid_event_data: 400,
  event_key_mismatch: 400,
  lang_unsupported: 400,
  event_data_too_large: 413,
  authorization_failed: 403,
  aimer_auth_failed: 502,
  aimer_invalid_request: 502,
  aimer_call_failed: 502,
  aimer_unavailable: 503,
  redaction_failed: 500,
  storage_failed: 500,
  internal_error: 500,
  invalid_context_token: 400,
  invalid_events_envelope: 400,
  invalid_analyze_params_token: 400,
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a styled HTML error page for the analyze-bridge endpoint.
 *
 * The wrapping endpoint surfaces failures to the end user in a new tab
 * (top-level navigation from aice-web-next), so a JSON envelope is
 * inappropriate. A minimal aimer-web-styled page communicates the
 * failure without depending on the application shell layout (the user
 * may not be signed in yet, depending on where in the flow the failure
 * occurred).
 */
export function renderAnalyzeBridgeErrorPage(
  errorCode: AnalyzeBridgeErrorCode,
  detailMessage: string,
): Response {
  const title = ANALYZE_BRIDGE_ERROR_TITLES[errorCode];
  const status = ERROR_HTTP_STATUS[errorCode];

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — aimer</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f9fafb;
      color: #111827;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f1f5f9; }
      .card { background: #1e293b; border-color: #334155; }
      .code { background: #0f172a; color: #cbd5e1; }
    }
    .card {
      max-width: 36rem;
      margin: 2rem;
      padding: 2rem;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    p { margin: 0 0 1rem; line-height: 1.5; }
    .code {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.875rem;
      background: #f3f4f6;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>The analyze request could not be completed.</p>
    <p>Error code: <span class="code">${escapeHtml(errorCode)}</span></p>
    <p>${escapeHtml(detailMessage)}</p>
  </main>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const SESSION_EXPIRED_BODY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Session expired — aimer</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f9fafb;
      color: #111827;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f1f5f9; }
      .card { background: #1e293b; border-color: #334155; }
    }
    .card {
      max-width: 36rem;
      margin: 2rem;
      padding: 2rem;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
    }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    p { margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Session expired</h1>
    <p>The analyze request expired before it could be completed. Please return to the original page and try again.</p>
  </main>
</body>
</html>`;

export function renderSessionExpiredPage(): Response {
  return new Response(SESSION_EXPIRED_BODY, {
    status: 410,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const NOT_FOUND_BODY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Not found — aimer</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f9fafb;
      color: #111827;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f1f5f9; }
      .card { background: #1e293b; border-color: #334155; }
    }
    .card {
      max-width: 36rem;
      margin: 2rem;
      padding: 2rem;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
    }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    p { margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Analyze request not found</h1>
    <p>This analyze request does not exist or has already been cleaned up.</p>
  </main>
</body>
</html>`;

export function renderAnalyzeBridgeNotFoundPage(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
