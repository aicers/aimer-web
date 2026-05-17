import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { EnvelopeVerificationError } = await import(
  "@/lib/auth/envelope-verify"
);
const { mapEnvelopeErrorToPhase2Response } = await import("../error-mapping");

type EnvelopeVerificationCode = NonNullable<
  ConstructorParameters<typeof EnvelopeVerificationError>[0]
>;

const cases: Array<[EnvelopeVerificationCode, number]> = [
  ["malformed_multipart", 400],
  ["missing_context_token", 400],
  ["missing_events_envelope", 400],
  ["missing_events_data", 400],
  ["malformed_payload", 400],
  ["missing_external_key", 400],
  ["invalid_context_token", 401],
  ["invalid_events_envelope", 401],
  ["trust_registry_key_expired", 401],
  ["payload_customer_not_authorized", 403],
  ["envelope_payload_aice_id_mismatch", 403],
  ["customer_not_found", 404],
  ["events_data_too_large", 413],
];

describe("mapEnvelopeErrorToPhase2Response", () => {
  it.each(cases)("maps %s to HTTP %i per RFC 0002 §6", async (code, status) => {
    const res = mapEnvelopeErrorToPhase2Response(
      new EnvelopeVerificationError(code, "msg"),
    );
    expect(res.status).toBe(status);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe(code);
  });
});
