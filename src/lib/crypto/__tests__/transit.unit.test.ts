import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptDataKey, generateDataKey, rewrapDataKey } from "../transit";

const config = { addr: "http://localhost:8200", token: "test-token" };

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

function transitOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generateDataKey", () => {
  it("calls transit/datakey/plaintext and returns key + wrapped DEK", async () => {
    const plaintext = Buffer.from("0123456789abcdef0123456789abcdef").toString(
      "base64",
    );
    const ciphertext = "vault:v1:wrappedkeydata";
    mockFetch.mockResolvedValueOnce(transitOk({ plaintext, ciphertext }));

    const result = await generateDataKey(config, "staging-events");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "http://localhost:8200/v1/transit/datakey/plaintext/staging-events",
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Vault-Token"]).toBe("test-token");

    expect(result.plaintext).toBeInstanceOf(Buffer);
    expect(result.wrappedDek).toBe(ciphertext);
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(generateDataKey(config, "staging-events")).rejects.toThrow(
      "Transit datakey/plaintext/staging-events failed (403)",
    );
  });

  it("throws on missing data in response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await expect(generateDataKey(config, "staging-events")).rejects.toThrow(
      "missing data in response",
    );
  });
});

describe("decryptDataKey", () => {
  it("calls transit/decrypt and returns plaintext Buffer", async () => {
    const plaintext = Buffer.from("secret-key-material").toString("base64");
    mockFetch.mockResolvedValueOnce(transitOk({ plaintext }));

    const result = await decryptDataKey(
      config,
      "staging-events",
      "vault:v1:wrappedkey",
    );

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("secret-key-material");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8200/v1/transit/decrypt/staging-events");
    const body = JSON.parse(opts.body);
    expect(body.ciphertext).toBe("vault:v1:wrappedkey");
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      decryptDataKey(config, "staging-events", "vault:v1:bad"),
    ).rejects.toThrow("failed (404)");
  });
});

describe("rewrapDataKey", () => {
  it("calls transit/rewrap and returns new wrapped DEK", async () => {
    mockFetch.mockResolvedValueOnce(
      transitOk({ ciphertext: "vault:v2:newwrappedkey" }),
    );

    const result = await rewrapDataKey(
      config,
      "staging-events",
      "vault:v1:oldwrappedkey",
    );

    expect(result).toBe("vault:v2:newwrappedkey");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8200/v1/transit/rewrap/staging-events");
    const body = JSON.parse(opts.body);
    expect(body.ciphertext).toBe("vault:v1:oldwrappedkey");
  });
});
