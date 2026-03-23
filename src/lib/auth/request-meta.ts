export interface RequestMeta {
  ipAddress: string;
  userAgent: string;
  origin: string | null;
}

export function extractRequestMeta(request: Request): RequestMeta {
  const headers = request.headers;
  const ipAddress =
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown";
  const userAgent = headers.get("user-agent") ?? "unknown";
  const origin = headers.get("origin") ?? headers.get("referer") ?? null;

  return { ipAddress, userAgent, origin };
}
