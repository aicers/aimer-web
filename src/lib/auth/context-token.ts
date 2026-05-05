import "server-only";

import { importJWK, jwtVerify } from "jose";
import type { Pool } from "pg";
import { TrustRegistryKeyExpiredError } from "./errors";
import { lookupTrustRegistryKey } from "./trust-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  aiceId: string;
  customerIds: string[];
  iat: number;
  exp: number;
  jti: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CUSTOMER_IDS = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a context token JWT from aice-web-next.
 *
 * Steps:
 * 1. Decode header to extract `kid` and `alg`
 * 2. Decode payload (unverified) to extract `aice_id` and `iss`
 * 3. Look up public key from trust registry
 * 4. Verify JWT signature + standard claims
 * 5. Validate `customer_ids` size limit
 * 6. Return verified claims
 *
 * Throws on any verification failure.
 */
export async function verifyContextToken(
  pool: Pool,
  token: string,
): Promise<ContextTokenClaims> {
  // Decode header and payload without verification to extract routing info
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid context token format");
  }

  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  );
  const unverifiedPayload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  );

  const kid = header.kid;
  const alg = header.alg;
  if (typeof kid !== "string" || typeof alg !== "string") {
    throw new Error("Context token header missing kid or alg");
  }

  const aiceId = unverifiedPayload.aice_id;
  const iss = unverifiedPayload.iss;
  if (typeof aiceId !== "string" || typeof iss !== "string") {
    throw new Error("Context token missing aice_id or iss");
  }

  // Look up public key from trust registry
  const lookup = await lookupTrustRegistryKey(pool, aiceId, iss, kid);
  if (!lookup.entry) {
    if (lookup.rejection.reason === "expired") {
      throw new TrustRegistryKeyExpiredError(
        `Trust registry: key expired (aice_id=${aiceId}, iss=${iss}, kid=${kid})`,
        {
          aiceId,
          issuer: iss,
          kid,
          expiresAtMs: lookup.rejection.expiresAtMs,
        },
      );
    }
    throw new Error(
      `Trust registry: unknown key (aice_id=${aiceId}, iss=${iss}, kid=${kid})`,
    );
  }

  const publicKey = await importJWK(lookup.entry.publicKey, alg);

  // Verify JWT signature + standard claims
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: iss,
    audience: "aimer-web",
  });

  // Validate required claims
  const sub = payload.sub;
  const jti = payload.jti;
  const verifiedAiceId = payload.aice_id;
  const customerIds = payload.customer_ids;
  const iat = payload.iat;
  const exp = payload.exp;

  if (typeof sub !== "string") {
    throw new Error("Context token missing sub");
  }
  if (typeof jti !== "string") {
    throw new Error("Context token missing jti");
  }
  if (typeof verifiedAiceId !== "string") {
    throw new Error("Context token missing aice_id");
  }
  if (typeof iat !== "number" || typeof exp !== "number") {
    throw new Error("Context token missing iat or exp");
  }

  if (!Array.isArray(customerIds)) {
    throw new Error("Context token missing customer_ids array");
  }
  for (const id of customerIds) {
    if (typeof id !== "string") {
      throw new Error("Context token customer_ids must be strings");
    }
  }

  // Size limit — DoS prevention. Checked on the raw array before dedupe
  // so a sender cannot bypass the cap by inflating with duplicates.
  if (customerIds.length > MAX_CUSTOMER_IDS) {
    throw new Error(
      `Context token customer_ids exceeds maximum (${customerIds.length} > ${MAX_CUSTOMER_IDS})`,
    );
  }

  // Treat customer_ids as a set: dedupe while preserving first-seen order.
  // Downstream code (`processBridgeCallback`) compares the requested keys
  // against a `SELECT DISTINCT` mapping query, so leaving duplicates in
  // would let a sender with a buggy / malformed token trip
  // `bridge_customer_mismatch` with an empty `requested ∖ matched`,
  // breaking the audit invariant.
  const uniqueCustomerIds = Array.from(new Set(customerIds as string[]));

  return {
    iss: iss as string,
    aud: "aimer-web",
    sub,
    aiceId: verifiedAiceId,
    customerIds: uniqueCustomerIds,
    iat,
    exp,
    jti,
  };
}
