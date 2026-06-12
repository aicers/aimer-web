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
  // A `FormData` body must keep the browser-generated
  // `multipart/form-data; boundary=…` Content-Type — hand-setting JSON here
  // would corrupt the multipart boundary. So omit Content-Type for FormData.
  const isFormData =
    typeof FormData !== "undefined" && options?.body instanceof FormData;

  const res = await fetch(url, {
    ...options,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
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
