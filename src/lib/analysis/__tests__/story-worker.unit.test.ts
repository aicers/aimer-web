import { ClientError } from "graphql-request";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { __testables } from "../story-worker";

const { classifyAimerError, checkRedactionPolicyVersion, jobStoryLockId2 } =
  __testables;

function fakeClientError(status: number): ClientError {
  // ClientError shape: { response: { status, errors } }
  return new ClientError(
    {
      status,
      errors: status >= 400 && status < 500 ? [{ message: "bad" }] : undefined,
      headers: new Headers(),
      data: null,
    } as unknown as ClientError["response"],
    { query: "x" },
  );
}

describe("classifyAimerError", () => {
  it("5xx → retryable aimer_5xx", () => {
    expect(classifyAimerError(fakeClientError(503))).toEqual({
      code: "aimer_5xx",
      retryable: true,
    });
  });

  it("4xx → fatal aimer_4xx", () => {
    expect(classifyAimerError(fakeClientError(401))).toEqual({
      code: "aimer_4xx",
      retryable: false,
    });
  });

  it("plain Error → retryable aimer_unavailable", () => {
    expect(classifyAimerError(new Error("ECONNREFUSED"))).toEqual({
      code: "aimer_unavailable",
      retryable: true,
    });
  });
});

describe("checkRedactionPolicyVersion", () => {
  it("returns ok when all members share the same non-empty version", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
      ]),
    ).toEqual({ kind: "ok", version: "engine:1.0|ranges:abc" });
  });

  it("returns missing on empty string version", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "" } as any,
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("returns mismatched when members disagree", () => {
    expect(
      checkRedactionPolicyVersion([
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:abc" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        { redaction_policy_version: "engine:1.0|ranges:xyz" } as any,
      ]),
    ).toEqual({ kind: "mismatched" });
  });

  it("returns missing for zero members", () => {
    expect(checkRedactionPolicyVersion([])).toEqual({ kind: "missing" });
  });
});

describe("jobStoryLockId2", () => {
  it("is deterministic for the same input", () => {
    expect(jobStoryLockId2("12345")).toBe(jobStoryLockId2("12345"));
  });
  it("returns a non-zero positive integer", () => {
    expect(jobStoryLockId2("12345")).toBeGreaterThan(0);
  });
});
