// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../client";

describe("apiFetch", () => {
  beforeEach(() => {
    // Set csrf cookie
    document.cookie = "csrf=test-csrf-token";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    // Clear cookie
    document.cookie = "csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    vi.restoreAllMocks();
  });

  it("sends CSRF token from cookie", async () => {
    await apiFetch("/api/test");

    expect(fetch).toHaveBeenCalledWith("/api/test", {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "test-csrf-token",
      },
    });
  });

  it("sends empty CSRF token when cookie is absent", async () => {
    document.cookie = "csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";

    await apiFetch("/api/test");

    expect(fetch).toHaveBeenCalledWith("/api/test", {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "",
      },
    });
  });

  it("returns parsed JSON on success", async () => {
    const result = await apiFetch<{ ok: boolean }>("/api/test");
    expect(result).toEqual({ ok: true });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const result = await apiFetch("/api/test");
    expect(result).toBeUndefined();
  });

  it("throws ApiError on non-ok response with error body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow(ApiError);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(apiFetch("/api/test")).rejects.toMatchObject({
      message: "Not found",
      status: 404,
    });
  });

  it("throws ApiError with statusText when body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow(ApiError);

    vi.mocked(fetch).mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(apiFetch("/api/test")).rejects.toMatchObject({
      message: "Internal Server Error",
      status: 500,
    });
  });

  it("merges custom headers with defaults", async () => {
    await apiFetch("/api/test", {
      method: "POST",
      headers: { "X-Custom": "value" },
    });

    expect(fetch).toHaveBeenCalledWith("/api/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "test-csrf-token",
        "X-Custom": "value",
      },
    });
  });

  it("allows overriding Content-Type header", async () => {
    await apiFetch("/api/test", {
      headers: { "Content-Type": "text/plain" },
    });

    expect(fetch).toHaveBeenCalledWith("/api/test", {
      headers: {
        "Content-Type": "text/plain",
        "X-CSRF-Token": "test-csrf-token",
      },
    });
  });
});

describe("ApiError", () => {
  it("has correct name and properties", () => {
    const error = new ApiError("Forbidden", 403);
    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("Forbidden");
    expect(error.status).toBe(403);
    expect(error).toBeInstanceOf(Error);
  });
});
