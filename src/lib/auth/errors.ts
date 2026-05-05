export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Thrown by token verifiers when a trust registry key's `expires_at` has
 * passed. The bridge route catches this to emit a specific audit reason
 * (`trust_registry_key_expired`) without leaking expiry details to the
 * caller.
 */
export class TrustRegistryKeyExpiredError extends Error {
  readonly expiresAtMs: number;

  constructor(
    message: string,
    options: {
      aiceId: string;
      issuer: string;
      kid: string;
      expiresAtMs: number;
    },
  ) {
    super(message);
    this.name = "TrustRegistryKeyExpiredError";
    this.aiceId = options.aiceId;
    this.issuer = options.issuer;
    this.kid = options.kid;
    this.expiresAtMs = options.expiresAtMs;
  }

  readonly aiceId: string;
  readonly issuer: string;
  readonly kid: string;
}
