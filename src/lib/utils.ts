import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Extract a concise, user-friendly error message from various error shapes
export function friendlyError(
  err: unknown,
  fallback = "Sign-in failed",
): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    // graphql-request ClientError-like shape
    const anyErr = err as {
      message?: string;
      response?: { errors?: Array<{ message?: string }> };
    };
    const gqlMsg = anyErr.response?.errors?.[0]?.message;
    if (gqlMsg && typeof gqlMsg === "string") return gqlMsg;
    if (anyErr.message && typeof anyErr.message === "string")
      return anyErr.message;
  }
  return fallback;
}

type NodeBuffer = {
  from(
    input: string,
    encoding: string,
  ): {
    toString(encoding: string): string;
  };
};

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4;
  const padded =
    padLength === 0 ? normalized : normalized + "=".repeat(4 - padLength);
  if (typeof globalThis.atob === "function") {
    return globalThis.atob(padded);
  }
  const nodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(padded, "base64").toString("utf-8");
  }
  throw new Error("Base64 decoding is not supported in this environment");
}

export function getRoleFromToken(token: string): string {
  const segments = token.split(".");
  if (segments.length < 2) {
    throw new Error("Invalid JWT: missing payload segment");
  }
  const payloadSegment = segments[1];
  const decoded = decodeBase64Url(payloadSegment);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch (_err) {
    throw new Error("Invalid JWT: payload is not valid JSON");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JWT: payload is not an object");
  }
  const role = (payload as { role?: unknown }).role;
  if (typeof role !== "string") {
    throw new Error("Invalid JWT: role is missing");
  }
  return role;
}
