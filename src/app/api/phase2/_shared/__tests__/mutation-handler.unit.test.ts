import { NextRequest } from "next/server";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyPhase2Multipart = vi.fn();
const mockAuditLog = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/envelope-verify", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/envelope-verify")>();
  return {
    ...actual,
    verifyPhase2Multipart: (...args: unknown[]) =>
      mockVerifyPhase2Multipart(...args),
  };
});

vi.mock("@/lib/audit", () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
  UNKNOWN_ACTOR_ID: "unknown",
}));

const { EnvelopeVerificationError } = await import(
  "@/lib/auth/envelope-verify"
);
const { createPhase2MutationHandler } = await import("../mutation-handler");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseContextClaims = {
  iss: "https://aice.test",
  aud: "aimer-web",
  sub: "user-1",
  aiceId: "aice-1",
  customerIds: ["ext-1"],
  iat: 1000,
  exp: 2000,
  jti: "550e8400-e29b-41d4-a716-446655440000",
};

const baseEnvelopeClaims = {
  iss: "https://aice.test",
  aiceId: "aice-1",
  customerIds: ["ext-1"],
  contextJti: baseContextClaims.jti,
  payloadHash: "hash",
  eventCount: 1,
  schemaVersion: "phase2.test.v1",
};

const baseEventsData = new TextEncoder().encode(
  '{"external_key":"ext-1","field":"value"}',
);

const testSchema = z.object({
  external_key: z.string(),
  field: z.string(),
});

function fakeAuthPool() {
  return {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
  } as unknown as Pool;
}

function makeRequest(): NextRequest {
  const form = new FormData();
  form.append("context_token", "x");
  form.append("events_envelope", "x");
  form.append("events_data", new TextDecoder().decode(baseEventsData));
  return new NextRequest("http://localhost/api/phase2/test", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPhase2MutationHandler", () => {
  it("returns 200 with the mutation response body and emits the success audit", async () => {
    const authPool = fakeAuthPool();
    const customerPool = fakeAuthPool();
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "11111111-2222-3333-4444-555555555555",
      externalKey: "ext-1",
    });

    const mutate = vi.fn().mockResolvedValue({
      responseBody: { withdrawn: 3, not_found: 1 },
      auditDetails: { withdrawn: 3, notFound: 1, kindsTouched: ["story"] },
    });

    const handler = createPhase2MutationHandler(
      {
        expectedSchemaVersion: "phase2.test.v1",
        payloadSchema: testSchema,
        auditTargetType: "phase2_withdraw",
        successAction: "phase2.withdraw",
        mutate,
      },
      {
        getAuthPool: () => authPool,
        getCustomerRuntimePool: () => customerPool,
      },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.withdrawn).toBe(3);
    expect(body.not_found).toBe(1);
    expect(body.context_jti).toBe(baseContextClaims.jti);
    expect(body.received_at).toMatch(/T.*Z$/);

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe("phase2.withdraw");
    expect(auditCall.aiceId).toBe(baseEnvelopeClaims.aiceId);
    expect(auditCall.customerId).toBe("11111111-2222-3333-4444-555555555555");
    expect(auditCall.correlationId).toBe(baseContextClaims.jti);
    expect(auditCall.details).toMatchObject({
      schemaVersion: "phase2.test.v1",
      withdrawn: 3,
      notFound: 1,
      kindsTouched: ["story"],
    });

    expect(authPool.query).toHaveBeenCalledWith(
      expect.stringContaining("phase2_consumed_jtis"),
      [baseContextClaims.jti],
    );
    expect(mutate).toHaveBeenCalled();
  });

  it("returns 409 context_jti_replay on replayed jti — no mutate, no audit, no customer-pool resolution", async () => {
    const authPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 0 }), // replay
    } as unknown as Pool;
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "c-1",
      externalKey: "ext-1",
    });

    const mutate = vi.fn();
    const getCustomerRuntimePool = vi.fn(() => fakeAuthPool());

    const handler = createPhase2MutationHandler(
      {
        expectedSchemaVersion: "phase2.test.v1",
        payloadSchema: testSchema,
        auditTargetType: "phase2_refresh_window",
        successAction: "phase2.refresh_window",
        mutate,
      },
      { getAuthPool: () => authPool, getCustomerRuntimePool },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe("context_jti_replay");
    expect(mutate).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
    // Critical: a replay must NOT even reach the per-window advisory
    // lock — i.e. it must NOT resolve the customer pool.
    expect(getCustomerRuntimePool).not.toHaveBeenCalled();
  });

  it("returns 400 schema_version_mismatch when envelope schema_version differs", async () => {
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: { ...baseEnvelopeClaims, schemaVersion: "wrong" },
      eventsData: baseEventsData,
      customerId: "c",
      externalKey: "ext-1",
    });
    const handler = createPhase2MutationHandler(
      {
        expectedSchemaVersion: "phase2.test.v1",
        payloadSchema: testSchema,
        auditTargetType: "phase2_backfill",
        successAction: "phase2.backfill",
        mutate: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );
    const res = await handler(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("schema_version_mismatch");
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("maps EnvelopeVerificationError to RFC 0002 status and emits phase2.verification_failed with the route's targetType", async () => {
    mockVerifyPhase2Multipart.mockRejectedValue(
      new EnvelopeVerificationError(
        "payload_customer_not_authorized",
        "scope",
        {
          contextClaims: baseContextClaims,
          details: { externalKey: "ext-1" },
        },
      ),
    );

    const handler = createPhase2MutationHandler(
      {
        expectedSchemaVersion: "phase2.test.v1",
        payloadSchema: testSchema,
        auditTargetType: "phase2_withdraw",
        successAction: "phase2.withdraw",
        mutate: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    expect(res.status).toBe(403);
    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.action).toBe("phase2.verification_failed");
    expect(call.targetType).toBe("phase2_withdraw");
    expect(call.details.code).toBe("payload_customer_not_authorized");
  });

  it("returns 500 database_error and emits phase2.ingest_failed when mutate throws — consumed jti remains", async () => {
    const authPool = fakeAuthPool();
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "c-1",
      externalKey: "ext-1",
    });
    const mutate = vi.fn().mockRejectedValue(new Error("boom"));
    const handler = createPhase2MutationHandler(
      {
        expectedSchemaVersion: "phase2.test.v1",
        payloadSchema: testSchema,
        auditTargetType: "phase2_refresh_window",
        successAction: "phase2.refresh_window",
        mutate,
      },
      {
        getAuthPool: () => authPool,
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );
    const res = await handler(makeRequest());
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(500);
    expect(body.code).toBe("database_error");

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.action).toBe("phase2.ingest_failed");
    expect(call.targetType).toBe("phase2_refresh_window");
    expect(call.details.error).toBe("boom");

    // jti was consumed and was NOT released — only the single INSERT
    // into phase2_consumed_jtis happened, no DELETE.
    expect(authPool.query).toHaveBeenCalledTimes(1);
    const firstCall = (authPool.query as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(firstCall[0]).toMatch(/phase2_consumed_jtis/);
  });
});
