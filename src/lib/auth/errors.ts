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

/**
 * Thrown by {@link verifyEventsEnvelope} when the supplied `events_data`
 * exceeds `BRIDGE_MAX_PAYLOAD_BYTES`. Distinguished from generic envelope
 * verification failures so Phase 2 routes can map it to HTTP 413 while
 * Phase 1 keeps mapping it to 403.
 */
export class PayloadTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`Events data exceeds size cap (${actualBytes} > ${maxBytes} bytes)`);
    this.name = "PayloadTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}
