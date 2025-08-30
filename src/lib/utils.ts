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
