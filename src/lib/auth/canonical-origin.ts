import type { NextRequest } from "next/server";

/**
 * Return the canonical origin to use when constructing OIDC redirect
 * URIs, callback/logout URLs, invitation links, absolute redirects,
 * and the expected origin in CSRF validation.
 *
 * Resolution order:
 * 1. `process.env.EXPECTED_ORIGIN` — operator-declared canonical source
 *    of truth. The value is canonicalised at server startup by
 *    `validateExpectedOriginEnv` in `src/instrumentation.ts`, which
 *    writes the normalised form back into `process.env.EXPECTED_ORIGIN`
 *    (no trailing slash, scheme/host lowercased).
 * 2. In production with `EXPECTED_ORIGIN` unset, this helper throws.
 *    Startup validation should have caught the missing env first, but a
 *    silent fall-through to the request origin in production would
 *    re-introduce the very defect this helper exists to prevent.
 * 3. In non-production with a `request` argument, the function falls
 *    back to `request.nextUrl.origin`.
 *
 * @throws When `EXPECTED_ORIGIN` is unset in production, or when no
 *   `request` is supplied and no env value is available.
 */
export function canonicalOrigin(request?: NextRequest): string {
  const fromEnv = process.env.EXPECTED_ORIGIN;
  if (fromEnv) {
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("EXPECTED_ORIGIN is required in production but not set");
  }
  if (request) {
    return request.nextUrl.origin;
  }
  throw new Error(
    "canonicalOrigin called without request and without EXPECTED_ORIGIN env",
  );
}
