// Unit tests for the shared per-subject TI-source route handlers (#598):
// subjectId extraction, error→status mapping, the GET catalog DTO shape, and
// that the admin vs general auth context is threaded into the service guard
// unchanged. The full permission matrix runs against a real DB in
// `ti-sources.db.test.ts`; here the service is mocked so the wiring +
// validation can be asserted without Postgres.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockRead = vi.fn();
const mockSet = vi.fn();
const mockClear = vi.fn();

vi.mock("../ti-sources", () => ({
  readSubjectTiSources: (...a: unknown[]) => mockRead(...a),
  setSubjectTiSources: (...a: unknown[]) => mockSet(...a),
  clearSubjectTiSources: (...a: unknown[]) => mockClear(...a),
  // Real-ish DTO: a narrow public shape (no descriptor internals).
  toCatalogDto: (enabled: string[]) => [
    {
      sourcePolicyId: "abuse.ch/feodo",
      label: "abuse.ch Feodo Tracker",
      entityTypes: ["IP"],
      enabled: enabled.includes("abuse.ch/feodo"),
      requiresCustomerKey: false,
    },
  ],
}));

vi.mock("@/lib/auth/guards", () => ({
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
}));

const { HttpError } = await import("@/lib/auth/errors");
const {
  extractSubjectId,
  handleGetSubjectTiSources,
  handlePutSubjectTiSources,
  handleDeleteSubjectTiSources,
} = await import("../subject-ti-sources-route");

const SUBJECT_ID = "c0000000-0000-0000-0000-000000000001";

// biome-ignore lint/suspicious/noExplicitAny: minimal AuthenticatedRequest stub
const auth: any = {
  accountId: "a0000000-0000-0000-0000-000000000009",
  sessionId: "sess-1",
  iat: 1000,
  meta: { ipAddress: "127.0.0.1", userAgent: "test" },
};

function req(path: string, method = "GET"): NextRequest {
  return new NextRequest(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
}

describe("subject-ti-sources route handlers", () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockSet.mockReset();
    mockClear.mockReset();
  });

  it("extractSubjectId reads the segment after `subjects` or `customers`", () => {
    expect(
      extractSubjectId(req(`/api/subjects/${SUBJECT_ID}/ti-sources`)),
    ).toBe(SUBJECT_ID);
    expect(
      extractSubjectId(req(`/api/admin/customers/${SUBJECT_ID}/ti-sources`)),
    ).toBe(SUBJECT_ID);
    expect(extractSubjectId(req("/api/subjects/not-a-uuid/ti-sources"))).toBe(
      null,
    );
  });

  it("GET returns effective + catalog DTO and threads the auth context", async () => {
    mockRead.mockResolvedValue({
      stored: null,
      effective: ["abuse.ch/feodo"],
      source: "global",
    });
    const res = await handleGetSubjectTiSources(
      req(`/api/subjects/${SUBJECT_ID}/ti-sources`),
      auth,
      "general",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("global");
    expect(body.enabledSourceIds).toEqual(["abuse.ch/feodo"]);
    // Catalog DTO exposes ONLY the public keys — never descriptor internals.
    expect(body.catalog).toHaveLength(1);
    expect(Object.keys(body.catalog[0]).sort()).toEqual([
      "enabled",
      "entityTypes",
      "label",
      "requiresCustomerKey",
      "sourcePolicyId",
    ]);
    expect(body.catalog[0].enabled).toBe(true);
    expect(mockRead).toHaveBeenCalledWith(
      {},
      "general",
      auth.accountId,
      SUBJECT_ID,
    );
  });

  it("PUT maps an empty-selection HttpError(422) to a 422 response", async () => {
    mockSet.mockRejectedValue(new HttpError("enabled_source_ids_empty", 422));
    const r = req(`/api/admin/customers/${SUBJECT_ID}/ti-sources`, "PUT");
    r.json = async () => ({ enabledSourceIds: [] });
    const res = await handlePutSubjectTiSources(r, auth, "admin");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("enabled_source_ids_empty");
    expect(mockSet.mock.calls[0][1]).toBe("admin");
  });

  it("PUT returns 400 on an invalid subject id before touching the service", async () => {
    const r = req("/api/admin/customers/nope/ti-sources", "PUT");
    r.json = async () => ({ enabledSourceIds: ["abuse.ch/feodo"] });
    const res = await handlePutSubjectTiSources(r, auth, "admin");
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("DELETE returns { cleared } from the service", async () => {
    mockClear.mockResolvedValue({ cleared: true });
    const res = await handleDeleteSubjectTiSources(
      req(`/api/subjects/${SUBJECT_ID}/ti-sources`, "DELETE"),
      auth,
      "general",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(true);
  });
});
