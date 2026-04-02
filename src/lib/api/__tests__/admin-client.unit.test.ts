// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch, getAdminCsrfToken } from "../admin-client";
import { ApiError } from "../client";

describe("getAdminCsrfToken", () => {
  afterEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: test needs direct cookie manipulation
    document.cookie =
      "csrf_admin=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("extracts token from csrf_admin cookie", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test needs direct cookie manipulation
    document.cookie = "csrf_admin=admin-token-123";
    expect(getAdminCsrfToken()).toBe("admin-token-123");
  });

  it("returns empty string when cookie is absent", () => {
    expect(getAdminCsrfToken()).toBe("");
  });

  it("ignores general csrf cookie", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test needs direct cookie manipulation
    document.cookie = "csrf=general-token";
    expect(getAdminCsrfToken()).toBe("");
  });
});

describe("adminFetch", () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: test needs direct cookie manipulation
    document.cookie = "csrf_admin=admin-csrf-token";
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
    // biome-ignore lint/suspicious/noDocumentCookie: test needs direct cookie manipulation
    document.cookie =
      "csrf_admin=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    vi.restoreAllMocks();
  });

  it("sends X-CSRF-Token-Admin header", async () => {
    await adminFetch("/api/admin/test");

    expect(fetch).toHaveBeenCalledWith("/api/admin/test", {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token-Admin": "admin-csrf-token",
      },
    });
  });

  it("returns parsed JSON on success", async () => {
    const result = await adminFetch<{ ok: boolean }>("/api/admin/test");
    expect(result).toEqual({ ok: true });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const result = await adminFetch("/api/admin/test");
    expect(result).toBeUndefined();
  });

  it("throws ApiError on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(adminFetch("/api/admin/test")).rejects.toThrow(ApiError);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(adminFetch("/api/admin/test")).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
    });
  });

  it("falls back to statusText when body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(adminFetch("/api/admin/test")).rejects.toMatchObject({
      message: "Internal Server Error",
      status: 500,
    });
  });

  it("merges custom headers with defaults", async () => {
    await adminFetch("/api/admin/test", {
      method: "POST",
      headers: { "X-Custom": "value" },
    });

    expect(fetch).toHaveBeenCalledWith("/api/admin/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token-Admin": "admin-csrf-token",
        "X-Custom": "value",
      },
    });
  });
});
