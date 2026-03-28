import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deleteTransitKey } from "../transit";

const config = { addr: "http://localhost:8200", token: "test-token" };

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe("deleteTransitKey", () => {
  it("configures deletion_allowed then deletes the key", async () => {
    // First call: POST config
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // Second call: DELETE key
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteTransitKey(config, "customer-abc-123");

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Config call
    const [configUrl, configOpts] = mockFetch.mock.calls[0];
    expect(configUrl).toBe(
      "http://localhost:8200/v1/transit/keys/customer-abc-123/config",
    );
    expect(configOpts.method).toBe("POST");
    expect(JSON.parse(configOpts.body)).toEqual({ deletion_allowed: true });

    // Delete call
    const [deleteUrl, deleteOpts] = mockFetch.mock.calls[1];
    expect(deleteUrl).toBe(
      "http://localhost:8200/v1/transit/keys/customer-abc-123",
    );
    expect(deleteOpts.method).toBe("DELETE");
  });

  it("throws if config call fails", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(deleteTransitKey(config, "customer-abc-123")).rejects.toThrow(
      "Transit keys/customer-abc-123/config failed (403)",
    );
  });

  it("throws if delete call fails", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(deleteTransitKey(config, "customer-abc-123")).rejects.toThrow(
      "Transit DELETE keys/customer-abc-123 failed (404)",
    );
  });
});
