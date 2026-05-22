/**
 * Validate and canonicalise the `EXPECTED_ORIGIN` deployment environment
 * variable. The BFF runs behind a reverse proxy in production, where
 * `request.nextUrl.origin` reflects the container-internal bind hostname
 * (e.g. `https://0.0.0.0:3000`) rather than the public canonical origin
 * the browser uses. `EXPECTED_ORIGIN` is the operator-declared canonical
 * source of truth.
 *
 * The function is split out as a pure, side-effect-free helper so it can
 * be unit-tested without booting the Next.js runtime.
 *
 * @returns The canonicalised origin (no trailing slash, scheme/host
 *   lowercased) when `value` is set and valid. `null` in non-production
 *   when `value` is unset — callers may then fall back to
 *   `request.nextUrl.origin`.
 * @throws When `value` is unset in production, when `value` cannot be
 *   parsed as a URL, or when it contains a path, query, or hash.
 */
export function validateExpectedOriginEnv(
  value: string | undefined,
  nodeEnv: string,
): string | null {
  if (!value) {
    if (nodeEnv === "production") {
      throw new Error(
        "EXPECTED_ORIGIN is required in production but not set. Set it to the public canonical origin (e.g. https://aimer-web.example.com).",
      );
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`EXPECTED_ORIGIN is malformed: ${value}`);
  }

  // The value is used to build OIDC redirect_uri, browser absolute redirects,
  // and to validate the browser-supplied `Origin` header. Only HTTP(S) origins
  // are meaningful in that context. Schemes such as `file:`, `ftp:`, or `ws:`
  // either parse to the literal string `"null"` for `url.origin` (opaque
  // origin) or produce a non-HTTP origin that would later throw `Invalid URL`
  // when concatenated with `/api/auth/callback`. Reject them here so startup
  // fails fast with a clear configuration error.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `EXPECTED_ORIGIN must use http: or https: scheme: ${value}`,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`EXPECTED_ORIGIN must not contain a path: ${value}`);
  }
  if (url.search || url.hash) {
    throw new Error(`EXPECTED_ORIGIN must not contain query or hash: ${value}`);
  }

  return url.origin;
}
