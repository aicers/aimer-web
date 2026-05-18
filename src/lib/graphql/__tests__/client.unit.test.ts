import { parse } from "graphql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const Q_HELLO = parse("query { __typename }");
const Q_A = parse("query A { __typename }");
const Q_B = parse("query B { __typename }");
const Q_WITH_VAR = parse("query ($id: ID!) { __typename }");

const fetchSpy = vi.fn();

const releaseSpy = vi.fn();
const createMtlsRequestAuthSpy = vi.fn();

vi.mock("@/lib/mtls", () => ({
  createMtlsRequestAuth: (...args: unknown[]): unknown =>
    createMtlsRequestAuthSpy(...args),
}));

vi.mock("undici", () => ({
  fetch: (...args: unknown[]): unknown => fetchSpy(...args),
}));

const CTX = { accountId: "acc-1", aiceId: "aice-1" };

function jsonOk() {
  return Promise.resolve(
    new Response(JSON.stringify({ data: { hello: "world" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("graphql client", () => {
  let client: typeof import("@/lib/graphql/client");

  beforeEach(async () => {
    vi.resetModules();
    process.env.AIMER_GRAPHQL_ENDPOINT = "https://aimer.example.com/graphql";

    fetchSpy.mockReset().mockImplementation(() => jsonOk());
    releaseSpy.mockReset();
    createMtlsRequestAuthSpy.mockReset().mockImplementation(async () => ({
      agent: { mock: "dispatcher" },
      token: "mock-jwt-token",
      release: releaseSpy,
    }));

    client = await import("@/lib/graphql/client");
  });

  afterEach(() => {
    delete process.env.AIMER_GRAPHQL_ENDPOINT;
  });

  // ── Authorization header ─────────────────────────────────────────

  describe("Authorization header", () => {
    it("attaches Bearer token from createMtlsRequestAuth", async () => {
      createMtlsRequestAuthSpy.mockResolvedValueOnce({
        agent: { mock: "dispatcher" },
        token: "test-token-123",
        release: releaseSpy,
      });

      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token-123");
    });

    it("treats the token as opaque per request", async () => {
      createMtlsRequestAuthSpy
        .mockResolvedValueOnce({
          agent: { mock: "dispatcher" },
          token: "token-1",
          release: releaseSpy,
        })
        .mockResolvedValueOnce({
          agent: { mock: "dispatcher" },
          token: "token-2",
          release: releaseSpy,
        });

      await client.graphqlRequest(Q_A, undefined, CTX);
      await client.graphqlRequest(Q_B, undefined, CTX);

      const headers1 = new Headers(fetchSpy.mock.calls[0][1].headers);
      const headers2 = new Headers(fetchSpy.mock.calls[1][1].headers);
      expect(headers1.get("Authorization")).toBe("Bearer token-1");
      expect(headers2.get("Authorization")).toBe("Bearer token-2");
    });
  });

  // ── Context → JWT subject mapping ────────────────────────────────

  describe("ctx → createMtlsRequestAuth mapping", () => {
    it("maps accountId → sub and aiceId → aice_id", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, {
        accountId: "acc-42",
        aiceId: "aice-99",
      });

      expect(createMtlsRequestAuthSpy).toHaveBeenCalledTimes(1);
      expect(createMtlsRequestAuthSpy).toHaveBeenCalledWith({
        sub: "acc-42",
        aice_id: "aice-99",
      });
    });

    it("does not pass any customer scope to the mTLS layer", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      const [callArg] = createMtlsRequestAuthSpy.mock.calls[0];
      expect(callArg).toEqual({ sub: "acc-1", aice_id: "aice-1" });
      expect(callArg).not.toHaveProperty("customer_ids");
      expect(callArg).not.toHaveProperty("customerIds");
    });
  });

  // ── Dispatcher injection ─────────────────────────────────────────

  describe("dispatcher injection", () => {
    it("injects mTLS dispatcher into fetch call", async () => {
      const mockAgent = { mock: "agent-dispatcher" };
      createMtlsRequestAuthSpy.mockResolvedValueOnce({
        agent: mockAgent,
        token: "mock-jwt-token",
        release: releaseSpy,
      });

      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.dispatcher).toBe(mockAgent);
    });

    it("calls createMtlsRequestAuth on every request (no client cache)", async () => {
      await client.graphqlRequest(Q_A, undefined, CTX);
      await client.graphqlRequest(Q_B, undefined, CTX);

      expect(createMtlsRequestAuthSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Lease lifecycle ──────────────────────────────────────────────

  describe("lease release", () => {
    it("releases the mtls lease on success", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, CTX);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("releases the mtls lease on async fetch rejection", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX),
      ).rejects.toThrow();
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("releases the mtls lease when graphql-request throws synchronously before await", async () => {
      // Pass a malformed document so graphql-request throws while serializing
      // — exercises the synchronous-throw path inside the try/finally.
      const badDoc = { kind: "Document" } as unknown as Parameters<
        typeof client.graphqlRequest
      >[0];
      await expect(
        client.graphqlRequest(badDoc, undefined, CTX),
      ).rejects.toThrow();
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── Variables forwarding ─────────────────────────────────────────

  describe("variables forwarding", () => {
    it("forwards variables in the request body", async () => {
      await client.graphqlRequest(
        Q_WITH_VAR as unknown as Parameters<
          typeof client.graphqlRequest<unknown, { id: string }>
        >[0],
        { id: "123" },
        CTX,
      );

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.variables).toEqual({ id: "123" });
    });

    it("sends request body without variables when undefined", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.query).toContain("__typename");
      expect(body.variables).toBeUndefined();
    });
  });

  // ── Endpoint configuration ───────────────────────────────────────

  describe("endpoint configuration", () => {
    it("sends request to AIMER_GRAPHQL_ENDPOINT", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      const [url] = fetchSpy.mock.calls[0];
      expect(url.toString()).toBe("https://aimer.example.com/graphql");
    });

    it("reads the endpoint lazily per request", async () => {
      await client.graphqlRequest(Q_A, undefined, CTX);
      process.env.AIMER_GRAPHQL_ENDPOINT = "https://other.example.com/graphql";
      await client.graphqlRequest(Q_B, undefined, CTX);

      expect(fetchSpy.mock.calls[0][0].toString()).toBe(
        "https://aimer.example.com/graphql",
      );
      expect(fetchSpy.mock.calls[1][0].toString()).toBe(
        "https://other.example.com/graphql",
      );
    });

    it("throws when AIMER_GRAPHQL_ENDPOINT is missing without acquiring a lease", async () => {
      delete process.env.AIMER_GRAPHQL_ENDPOINT;

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX),
      ).rejects.toThrow("Missing environment variable: AIMER_GRAPHQL_ENDPOINT");
      expect(createMtlsRequestAuthSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws when AIMER_GRAPHQL_ENDPOINT is empty without acquiring a lease", async () => {
      process.env.AIMER_GRAPHQL_ENDPOINT = "";

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX),
      ).rejects.toThrow("Missing environment variable: AIMER_GRAPHQL_ENDPOINT");
      expect(createMtlsRequestAuthSpy).not.toHaveBeenCalled();
    });
  });

  // ── Error propagation ────────────────────────────────────────────

  describe("error propagation", () => {
    it("propagates createMtlsRequestAuth errors", async () => {
      createMtlsRequestAuthSpy.mockRejectedValueOnce(
        new Error("Missing environment variable: MTLS_CERT_PATH"),
      );

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX),
      ).rejects.toThrow("Missing environment variable: MTLS_CERT_PATH");
      // No lease was acquired, so release must not have run.
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it("propagates fetch/network errors", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX),
      ).rejects.toThrow("fetch failed");
    });
  });

  // ── Raw-string guard ─────────────────────────────────────────────

  describe("raw-string guard", () => {
    it("rejects raw query strings smuggled past the type system before any I/O", async () => {
      const rawQuery = "query { hello }" as unknown as Parameters<
        typeof client.graphqlRequest
      >[0];

      await expect(
        client.graphqlRequest(rawQuery, undefined, CTX),
      ).rejects.toThrow(/raw query strings are not allowed/);

      expect(createMtlsRequestAuthSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
    });
  });

  // ── AbortSignal forwarding ───────────────────────────────────────

  describe("abort signal forwarding", () => {
    it("forwards options.signal to the underlying fetch", async () => {
      const controller = new AbortController();

      await client.graphqlRequest(Q_HELLO, undefined, CTX, {
        signal: controller.signal,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      expect(init.signal).toBe(controller.signal);
    });

    it("rejects promptly when the signal aborts before a slow response, and releases the lease", async () => {
      fetchSpy.mockImplementationOnce((_input, init) => {
        return new Promise((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      });

      const controller = new AbortController();
      const promise = client.graphqlRequest(Q_HELLO, undefined, CTX, {
        signal: controller.signal,
      });
      queueMicrotask(() => controller.abort());

      await expect(promise).rejects.toThrow(/abort/i);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects when the signal is already aborted, and releases the lease", async () => {
      const controller = new AbortController();
      controller.abort();

      fetchSpy.mockImplementationOnce((_input, init) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return jsonOk();
      });

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, CTX, {
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/i);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("omits signal from the fetch init when not supplied", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, CTX);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.signal).toBeUndefined();
    });
  });
});
