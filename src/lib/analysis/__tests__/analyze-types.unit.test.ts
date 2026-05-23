import { describe, expect, it } from "vitest";
import { analyzeErrorResponse } from "../analyze-types";

describe("analyzeErrorResponse — RFC 0001 error table", () => {
  it("maps invalid_event_data to 400 with retryable=false", async () => {
    const res = analyzeErrorResponse("invalid_event_data", "x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("invalid_event_data");
    expect(body.error.retryable).toBe(false);
  });

  it("maps event_time_invalid to 400 with retryable=false", async () => {
    const res = analyzeErrorResponse("event_time_invalid", "x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("event_time_invalid");
    expect(body.error.retryable).toBe(false);
  });

  it("maps event_data_too_large to 413", async () => {
    const res = analyzeErrorResponse("event_data_too_large", "x");
    expect(res.status).toBe(413);
  });

  it("maps authorization_failed to 403", async () => {
    const res = analyzeErrorResponse("authorization_failed", "x");
    expect(res.status).toBe(403);
  });

  it("maps aimer_call_failed to 502 with retryable=true", async () => {
    const res = analyzeErrorResponse("aimer_call_failed", "x");
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { retryable: boolean };
    };
    expect(body.error.retryable).toBe(true);
  });

  it("maps aimer_unavailable to 503 with retryable=true", async () => {
    const res = analyzeErrorResponse("aimer_unavailable", "x");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { retryable: boolean };
    };
    expect(body.error.retryable).toBe(true);
  });

  it("maps storage_failed to 500 with retryable=true", async () => {
    const res = analyzeErrorResponse("storage_failed", "x");
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { retryable: boolean };
    };
    expect(body.error.retryable).toBe(true);
  });

  it("maps redaction_failed to 500 with retryable=false", async () => {
    const res = analyzeErrorResponse("redaction_failed", "x");
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { retryable: boolean };
    };
    expect(body.error.retryable).toBe(false);
  });
});
