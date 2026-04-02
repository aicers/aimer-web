import { ApiError } from "./client";

export function getAdminCsrfToken(): string {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith("csrf_admin="));
  return match ? match.split("=")[1] : "";
}

export async function adminFetch<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token-Admin": getAdminCsrfToken(),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { error?: string }).error ?? res.statusText,
      res.status,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
