// Unit tests for the shared per-customer default-model route handlers
// (#473): customerId extraction, error→status mapping, and that the
// admin vs general auth context is threaded into the service guard
// unchanged. The full permission matrix is exercised against a real DB
// in `default-model.db.test.ts`; here the service is mocked so the
// wiring + validation can be asserted without Postgres.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockRead = vi.fn();
const mockSet = vi.fn();
const mockClear = vi.fn();

vi.mock("../default-model", () => ({
  readCustomerDefaultModel: (...a: unknown[]) => mockRead(...a),
  setCustomerDefaultModel: (...a: unknown[]) => mockSet(...a),
  clearCustomerDefaultModel: (...a: unknown[]) => mockClear(...a),
  getEnvDefaultModel: () => ({ modelName: "openai", model: "gpt-4o" }),
}));

vi.mock("../model-catalog", () => ({
  getModelCatalog: () => [
    { modelName: "openai", model: "gpt-4o", label: "OpenAI GPT-4o" },
  ],
}));

vi.mock("@/lib/auth/guards", () => ({
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

// `withTransaction` just hands the callback a stub client.
vi.mock("@/lib/db/client", () => ({
  getAuthPool: () => ({}),
  withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
}));

const { HttpError } = await import("@/lib/auth/errors");
const {
  extractCustomerId,
  handleGetCustomerDefaultModel,
  handlePutCustomerDefaultModel,
  handleDeleteCustomerDefaultModel,
} = await import("../customer-default-model-route");

const CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";

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

describe("customer-default-model route handlers", () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockSet.mockReset();
    mockClear.mockReset();
  });

  it("extractCustomerId reads the segment after `customers`", () => {
    expect(
      extractCustomerId(
        req(`/api/admin/customers/${CUSTOMER_ID}/default-model`),
      ),
    ).toBe(CUSTOMER_ID);
    expect(extractCustomerId(req("/api/admin/customers/not-a-uuid/x"))).toBe(
      null,
    );
  });

  it("GET returns the view plus catalog and threads the auth context", async () => {
    mockRead.mockResolvedValue({
      override: null,
      effective: { modelName: "openai", model: "gpt-4o" },
      source: "env",
    });
    const res = await handleGetCustomerDefaultModel(
      req(`/api/customers/${CUSTOMER_ID}/analysis/default-model`),
      auth,
      "general",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("env");
    expect(body.catalog).toHaveLength(1);
    expect(mockRead).toHaveBeenCalledWith(
      {},
      "general",
      auth.accountId,
      CUSTOMER_ID,
    );
  });

  it("PUT maps an out-of-catalog HttpError(422) to a 422 response", async () => {
    mockSet.mockRejectedValue(new HttpError("model_not_in_catalog", 422));
    const r = req(`/api/admin/customers/${CUSTOMER_ID}/default-model`, "PUT");
    r.json = async () => ({ modelName: "bad", model: "model" });
    const res = await handlePutCustomerDefaultModel(r, auth, "admin");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("model_not_in_catalog");
    // admin context threaded through to the service
    expect(mockSet.mock.calls[0][1]).toBe("admin");
  });

  it("PUT returns 400 on an invalid customer id before touching the service", async () => {
    const r = req("/api/admin/customers/nope/default-model", "PUT");
    r.json = async () => ({ modelName: "openai", model: "gpt-4o" });
    const res = await handlePutCustomerDefaultModel(r, auth, "admin");
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("DELETE returns { cleared } from the service", async () => {
    mockClear.mockResolvedValue({ cleared: true });
    const res = await handleDeleteCustomerDefaultModel(
      req(`/api/customers/${CUSTOMER_ID}/analysis/default-model`, "DELETE"),
      auth,
      "general",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(true);
  });
});
