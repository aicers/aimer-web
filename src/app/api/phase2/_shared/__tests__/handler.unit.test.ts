import { NextRequest } from "next/server";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyPhase2Multipart = vi.fn();
const mockAuditLog = vi.fn();
const mockAuditLogOrThrow = vi.fn();
const mockApplyCursorWatermarkHook = vi.fn();

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
  auditLogOrThrow: (...args: unknown[]) => mockAuditLogOrThrow(...args),
  UNKNOWN_ACTOR_ID: "unknown",
}));

vi.mock("@/lib/analysis/ingest-hooks", () => ({
  applyCursorWatermarkHook: (...args: unknown[]) =>
    mockApplyCursorWatermarkHook(...args),
}));

const { EnvelopeVerificationError } = await import(
  "@/lib/auth/envelope-verify"
);
const { createPhase2BatchHandler } = await import("../handler");

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
  schemaVersion: "test.v1",
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

describe("createPhase2BatchHandler", () => {
  it("returns 200 with the RFC 0002 §6 response shape on the happy path", async () => {
    const authPool = fakeAuthPool();
    const customerPool = fakeAuthPool();
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "11111111-2222-3333-4444-555555555555",
      externalKey: "ext-1",
    });

    const ingest = vi
      .fn()
      .mockResolvedValue({ counts: { accepted: 3, duplicatesSkipped: 1 } });

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest,
      },
      {
        getAuthPool: () => authPool,
        getCustomerRuntimePool: () => customerPool,
      },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as {
      accepted: number;
      duplicates_skipped: number;
      received_at: string;
      context_jti: string;
    };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(3);
    expect(body.duplicates_skipped).toBe(1);
    expect(body.context_jti).toBe(baseContextClaims.jti);
    expect(body.received_at).toMatch(/T.*Z$/);

    // Audit fired exactly once with the standard details fields.
    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe("phase2.ingest");
    expect(auditCall.aiceId).toBe(baseEnvelopeClaims.aiceId);
    expect(auditCall.customerId).toBe("11111111-2222-3333-4444-555555555555");
    expect(auditCall.correlationId).toBe(baseContextClaims.jti);
    expect(auditCall.details).toMatchObject({
      schemaVersion: "test.v1",
      accepted: 3,
      duplicatesSkipped: 1,
      eventCountClaim: 1,
    });

    // jti was consumed via auth pool INSERT.
    expect(authPool.query).toHaveBeenCalledWith(
      expect.stringContaining("phase2_consumed_jtis"),
      [baseContextClaims.jti],
    );

    expect(ingest).toHaveBeenCalled();
  });

  it("returns 400 schema_version_mismatch when envelope schema_version differs", async () => {
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: { ...baseEnvelopeClaims, schemaVersion: "test.v2" },
      eventsData: baseEventsData,
      customerId: "c-1",
      externalKey: "ext-1",
    });

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(400);
    expect(body.code).toBe("schema_version_mismatch");
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 payload_schema_invalid on Zod failure", async () => {
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: new TextEncoder().encode('{"external_key":"ext-1"}'), // missing `field`
      customerId: "c-1",
      externalKey: "ext-1",
    });

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(400);
    expect(body.code).toBe("payload_schema_invalid");
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 context_jti_replay when consumer reports a duplicate jti", async () => {
    // rowCount 0 → replay.
    const authPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 0 }),
    } as unknown as Pool;
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "c-1",
      externalKey: "ext-1",
    });

    const ingest = vi.fn();
    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest,
      },
      {
        getAuthPool: () => authPool,
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe("context_jti_replay");
    // No ingest, no audit emitted on replay.
    expect(ingest).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("maps EnvelopeVerificationError codes to RFC 0002 Phase 2 statuses and emits phase2.verification_failed audit", async () => {
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

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("payload_customer_not_authorized");

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe("phase2.verification_failed");
    expect(auditCall.actorId).toBe(baseContextClaims.sub);
    expect(auditCall.aiceId).toBe(baseContextClaims.aiceId);
    expect(auditCall.correlationId).toBe(baseContextClaims.jti);
    expect(auditCall.details).toMatchObject({
      code: "payload_customer_not_authorized",
      schemaVersion: "test.v1",
      externalKey: "ext-1",
    });
  });

  it("emits phase2.verification_failed with UNKNOWN_ACTOR_ID when failure precedes context-token verification", async () => {
    mockVerifyPhase2Multipart.mockRejectedValue(
      new EnvelopeVerificationError("invalid_context_token", "bad sig"),
    );

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    expect(res.status).toBe(401);

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe("phase2.verification_failed");
    expect(auditCall.actorId).toBe("unknown");
    expect(auditCall.aiceId).toBeUndefined();
    expect(auditCall.correlationId).toBeUndefined();
    expect(auditCall.details).toMatchObject({
      code: "invalid_context_token",
      schemaVersion: "test.v1",
    });
  });

  it("returns 500 database_error and emits phase2.ingest_failed audit on ingest throw", async () => {
    const authPool = fakeAuthPool();
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "11111111-2222-3333-4444-555555555555",
      externalKey: "ext-1",
    });

    const ingest = vi.fn().mockRejectedValue(new Error("FK violation"));
    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest,
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

    // Failure audit emitted; phase2.ingest (success) is NOT emitted.
    expect(mockAuditLog).toHaveBeenCalledOnce();
    const auditCall = mockAuditLog.mock.calls[0][0];
    expect(auditCall.action).toBe("phase2.ingest_failed");
    expect(auditCall.customerId).toBe("11111111-2222-3333-4444-555555555555");
    expect(auditCall.correlationId).toBe(baseContextClaims.jti);
    expect(auditCall.details).toMatchObject({
      schemaVersion: "test.v1",
      eventCountClaim: 1,
      error: "FK violation",
    });
  });

  it("emits redaction.injectivity_violation alongside ingest_failed on engine injectivity throw", async () => {
    const { RedactionInjectivityError } = await import("@/lib/redaction");
    const authPool = fakeAuthPool();
    mockVerifyPhase2Multipart.mockResolvedValue({
      contextClaims: baseContextClaims,
      envelopeClaims: baseEnvelopeClaims,
      eventsData: baseEventsData,
      customerId: "11111111-2222-3333-4444-555555555555",
      externalKey: "ext-1",
    });

    const injErr = new RedactionInjectivityError({
      message: "engine: value '1.2.3.4' double-mapped",
      value: "1.2.3.4",
      existingToken: "<<REDACTED_IP_001>>",
      conflictingToken: "<<REDACTED_IP_002>>",
      existingKind: "ip",
      conflictingKind: "ip",
    });
    injErr.eventKey = "7";
    const ingest = vi.fn().mockRejectedValue(injErr);

    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest,
      },
      {
        getAuthPool: () => authPool,
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );

    const res = await handler(makeRequest());
    expect(res.status).toBe(500);

    const actions = mockAuditLog.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain("redaction.injectivity_violation");
    expect(actions).toContain("phase2.ingest_failed");

    const injCall = mockAuditLog.mock.calls.find(
      (c) =>
        (c[0] as { action: string }).action ===
        "redaction.injectivity_violation",
    );
    const injDetails = (
      injCall?.[0] as { details: { conflict: unknown; eventKey?: string } }
    ).details;
    expect(injDetails.eventKey).toBe("7");
    expect(injDetails.conflict).toMatchObject({
      value: "1.2.3.4",
      existingToken: "<<REDACTED_IP_001>>",
      conflictingToken: "<<REDACTED_IP_002>>",
      existingKind: "ip",
      conflictingKind: "ip",
    });
  });

  it("propagates non-EnvelopeVerificationError throws", async () => {
    mockVerifyPhase2Multipart.mockRejectedValue(new Error("boom"));
    const handler = createPhase2BatchHandler(
      {
        expectedSchemaVersion: "test.v1",
        payloadSchema: testSchema,
        auditTargetType: "test",
        ingest: vi.fn(),
      },
      {
        getAuthPool: () => fakeAuthPool(),
        getCustomerRuntimePool: () => fakeAuthPool(),
      },
    );
    await expect(handler(makeRequest())).rejects.toThrow("boom");
  });

  // RFC 0002 Phase 0.5 (#295) — cursor-bearing audit fail-closed path.
  describe("cursor-bearing audit write (issue #295 decision 9)", () => {
    const cursorEventTime = new Date("2026-05-28T12:00:00.000Z");
    const cursorEnvelopeClaims = {
      ...baseEnvelopeClaims,
      cursorEventTime,
      cursorQuality: "strict" as const,
    };

    it("uses auditLogOrThrow and includes cursor fields on the success path", async () => {
      const authPool = fakeAuthPool();
      const customerPool = fakeAuthPool();
      mockVerifyPhase2Multipart.mockResolvedValue({
        contextClaims: baseContextClaims,
        envelopeClaims: cursorEnvelopeClaims,
        eventsData: baseEventsData,
        customerId: "11111111-2222-3333-4444-555555555555",
        externalKey: "ext-1",
      });
      mockAuditLogOrThrow.mockResolvedValue(undefined);

      const ingest = vi
        .fn()
        .mockResolvedValue({ counts: { accepted: 1, duplicatesSkipped: 0 } });

      const handler = createPhase2BatchHandler(
        {
          expectedSchemaVersion: "test.v1",
          payloadSchema: testSchema,
          auditTargetType: "test",
          ingest,
        },
        {
          getAuthPool: () => authPool,
          getCustomerRuntimePool: () => customerPool,
        },
      );

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);

      // fire-and-forget auditLog was NOT used for the success row.
      expect(mockAuditLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "phase2.ingest" }),
      );
      expect(mockAuditLogOrThrow).toHaveBeenCalledOnce();
      const params = mockAuditLogOrThrow.mock.calls[0][0];
      expect(params.action).toBe("phase2.ingest");
      expect(params.details).toMatchObject({
        cursorEventTime: cursorEventTime.toISOString(),
        cursorQuality: "strict",
      });

      // Watermark hook fired with the same fields.
      expect(mockApplyCursorWatermarkHook).toHaveBeenCalledWith(
        authPool,
        expect.objectContaining({
          customerId: "11111111-2222-3333-4444-555555555555",
          cursorEventTime,
          cursorQuality: "strict",
        }),
      );
    });

    it("still returns 200 when the awaited audit write throws (fail-closed)", async () => {
      const authPool = fakeAuthPool();
      const customerPool = fakeAuthPool();
      mockVerifyPhase2Multipart.mockResolvedValue({
        contextClaims: baseContextClaims,
        envelopeClaims: cursorEnvelopeClaims,
        eventsData: baseEventsData,
        customerId: "11111111-2222-3333-4444-555555555555",
        externalKey: "ext-1",
      });
      mockAuditLogOrThrow.mockRejectedValue(new Error("audit pool down"));

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const ingest = vi
        .fn()
        .mockResolvedValue({ counts: { accepted: 1, duplicatesSkipped: 0 } });

      const handler = createPhase2BatchHandler(
        {
          expectedSchemaVersion: "test.v1",
          payloadSchema: testSchema,
          auditTargetType: "test",
          ingest,
        },
        {
          getAuthPool: () => authPool,
          getCustomerRuntimePool: () => customerPool,
        },
      );

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accepted: number };
      expect(body.accepted).toBe(1);

      // Error log emitted with cursor fields for ops recovery.
      const cursorLogs = errorSpy.mock.calls.filter((c) =>
        String(c[0] ?? "").includes("cursor-bearing audit write failed"),
      );
      expect(cursorLogs.length).toBeGreaterThanOrEqual(1);
      const ctx = cursorLogs[0][1] as Record<string, unknown>;
      expect(ctx).toMatchObject({
        customerId: "11111111-2222-3333-4444-555555555555",
        cursorEventTime: cursorEventTime.toISOString(),
        cursorQuality: "strict",
        contextJti: baseContextClaims.jti,
      });

      // JTI is consumed (the auth pool INSERT happened).
      expect(authPool.query).toHaveBeenCalledWith(
        expect.stringContaining("phase2_consumed_jtis"),
        [baseContextClaims.jti],
      );

      errorSpy.mockRestore();
    });

    it("stays on fire-and-forget auditLog when no cursor claims are present", async () => {
      const authPool = fakeAuthPool();
      const customerPool = fakeAuthPool();
      mockVerifyPhase2Multipart.mockResolvedValue({
        contextClaims: baseContextClaims,
        envelopeClaims: baseEnvelopeClaims,
        eventsData: baseEventsData,
        customerId: "c-1",
        externalKey: "ext-1",
      });

      const ingest = vi
        .fn()
        .mockResolvedValue({ counts: { accepted: 1, duplicatesSkipped: 0 } });

      const handler = createPhase2BatchHandler(
        {
          expectedSchemaVersion: "test.v1",
          payloadSchema: testSchema,
          auditTargetType: "test",
          ingest,
        },
        {
          getAuthPool: () => authPool,
          getCustomerRuntimePool: () => customerPool,
        },
      );

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "phase2.ingest" }),
      );
      expect(mockAuditLogOrThrow).not.toHaveBeenCalled();
      expect(mockApplyCursorWatermarkHook).not.toHaveBeenCalled();
    });
  });
});
