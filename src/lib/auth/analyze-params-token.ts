import "server-only";

import { createHash } from "node:crypto";
import { compactVerify, importJWK } from "jose";
import type { Pool } from "pg";
import type { ContextTokenClaims } from "./context-token";
import { TrustRegistryKeyExpiredError } from "./errors";
import type { EventsEnvelopeClaims } from "./events-envelope";
import { lookupTrustRegistryKey } from "./trust-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyzeParamsTokenClaims {
  contextJti: string;
  payloadHash: string;
  envelopeHash: string;
  eventKey: string;
  /**
   * Mirrors aimer's `Language` (nullable). REview MAY omit `lang` to
   * let aimer apply its server-side default; the BFF carries the
   * absence end-to-end. A present `lang` claim must still be a
   * non-empty string (validated against `SupportedLang` at the route
   * boundary).
   */
  lang: string | null;
  modelName: string;
  model: string;
  force: boolean;
  externalKey: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the sibling JWS `analyze_params_token` that carries the
 * analyze-specific parameters (event_key, lang, model_name, model,
 * force, external_key) alongside the bridge envelope.
 *
 * The three cross-binding assertions tie the params to the envelope so
 * an attacker who substitutes either the envelope or the params must
 * also forge a SHA-256 collision against the specific JWS bytes:
 *
 *   1. context_jti  === contextClaims.jti
 *   2. payload_hash === envelopeClaims.payloadHash
 *   3. envelope_hash === base64url(SHA-256(events_envelope JWS bytes))
 *
 * The key signing this token is registered in the trust registry under
 * the same (aice_id, issuer) tuple as the envelope. The lookup uses
 * the verifier's existing module-level TTL'd cache — no extra DB
 * round-trip on the warm path.
 */
export async function verifyAnalyzeParamsToken(
  pool: Pool,
  token: string,
  envelopeJws: string,
  contextClaims: ContextTokenClaims,
  envelopeClaims: EventsEnvelopeClaims,
): Promise<AnalyzeParamsTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid analyze_params_token format");
  }

  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  );
  const kid = header.kid;
  const alg = header.alg;
  if (typeof kid !== "string" || typeof alg !== "string") {
    throw new Error("analyze_params_token header missing kid or alg");
  }

  const lookup = await lookupTrustRegistryKey(
    pool,
    contextClaims.aiceId,
    contextClaims.iss,
    kid,
  );
  if (!lookup.entry) {
    if (lookup.rejection.reason === "expired") {
      throw new TrustRegistryKeyExpiredError(
        "analyze_params_token: trust registry key expired",
        {
          aiceId: contextClaims.aiceId,
          issuer: contextClaims.iss,
          kid,
          expiresAtMs: lookup.rejection.expiresAtMs,
        },
      );
    }
    throw new Error("analyze_params_token: unknown key in trust registry");
  }

  const publicKey = await importJWK(lookup.entry.publicKey, alg);
  const { payload: rawPayload } = await compactVerify(token, publicKey);

  const claims = JSON.parse(new TextDecoder().decode(rawPayload));

  const contextJti = claims.context_jti;
  const payloadHash = claims.payload_hash;
  const envelopeHash = claims.envelope_hash;
  const eventKey = claims.event_key;
  // `lang` is optional. `undefined` and the explicit JSON `null` both
  // mean "let aimer apply its default". A present claim must still be
  // a non-empty string (the `SupportedLang` check runs at the route
  // boundary so this verifier stays codec-only).
  const rawLang = claims.lang;
  let lang: string | null;
  if (rawLang === undefined || rawLang === null) {
    lang = null;
  } else if (typeof rawLang === "string" && rawLang.length > 0) {
    lang = rawLang;
  } else {
    throw new Error("analyze_params_token lang must be a non-empty string");
  }
  const modelName = claims.model_name;
  const model = claims.model;
  const force = claims.force;
  const externalKey = claims.external_key;

  if (typeof contextJti !== "string") {
    throw new Error("analyze_params_token missing context_jti");
  }
  if (typeof payloadHash !== "string") {
    throw new Error("analyze_params_token missing payload_hash");
  }
  if (typeof envelopeHash !== "string") {
    throw new Error("analyze_params_token missing envelope_hash");
  }
  if (typeof eventKey !== "string" || eventKey.length === 0) {
    throw new Error("analyze_params_token missing event_key");
  }
  if (typeof modelName !== "string" || modelName.length === 0) {
    throw new Error("analyze_params_token missing model_name");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("analyze_params_token missing model");
  }
  if (typeof force !== "boolean") {
    throw new Error("analyze_params_token missing force");
  }
  if (typeof externalKey !== "string" || externalKey.length === 0) {
    throw new Error("analyze_params_token missing external_key");
  }

  // Cross-binding assertions — Q2 PR-gating coverage.
  if (contextJti !== contextClaims.jti) {
    throw new Error(
      "analyze_params_token context_jti does not match context token",
    );
  }
  if (payloadHash !== envelopeClaims.payloadHash) {
    throw new Error(
      "analyze_params_token payload_hash does not match envelope",
    );
  }
  const expectedEnvelopeHash = createHash("sha256")
    .update(envelopeJws)
    .digest("base64url");
  if (envelopeHash !== expectedEnvelopeHash) {
    throw new Error(
      "analyze_params_token envelope_hash does not match events_envelope bytes",
    );
  }

  return {
    contextJti,
    payloadHash,
    envelopeHash,
    eventKey,
    lang,
    modelName,
    model,
    force,
    externalKey,
  };
}
