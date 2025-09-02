import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock next/headers cookies store to control presence/value of aimer_token
let currentToken: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "aimer_token" && currentToken
        ? { value: currentToken }
        : undefined,
  }),
}));

// Set a dummy upstream
beforeEach(() => {
  process.env.AIMER_GRAPHQL_ENDPOINT = "https://upstream.example.com/graphql";
  currentToken = "jwt-token";

  // Default mock fetch returns a simple JSON payload
  const mockFetch: typeof fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: mockFetch,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function callProxy(body: unknown) {
  const { POST } = await import("@/app/api/graphql/route");
  const req = new Request("http://localhost/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

describe("GraphQL proxy Authorization behavior", () => {
  test("skips Authorization for SignIn operation", async () => {
    await callProxy({
      operationName: "SignIn",
      query:
        "mutation SignIn($u: String!, $p: String!) { signIn(username: $u, password: $p) { token } }",
      variables: { u: "user", p: "pw" },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const mock = global.fetch as unknown as {
      mock: { calls: [string, RequestInit][] };
    };
    const [_url, init] = mock.mock.calls[0];
    expect(_url).toBe("https://upstream.example.com/graphql");
    expect(init?.headers).toBeDefined();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // Should not include Authorization on sign in
    expect(Object.keys(headers)).not.toContain("Authorization");
  });

  test("adds Authorization for non-SignIn operation", async () => {
    await callProxy({ operationName: "Me", query: "query Me { me { id } }" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const mock = global.fetch as unknown as {
      mock: { calls: [string, RequestInit][] };
    };
    const [_url, init] = mock.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${currentToken}`);
  });

  test("skips Authorization for batch containing SignIn", async () => {
    await callProxy([
      {
        operationName: "SignIn",
        query: "mutation SignIn { signIn { token } }",
      },
      { operationName: "Me", query: "query Me { me { id } }" },
    ]);

    const mock = global.fetch as unknown as {
      mock: { calls: [string, RequestInit][] };
    };
    const [_url, init] = mock.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers)).not.toContain("Authorization");
  });
});
