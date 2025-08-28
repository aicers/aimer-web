import { cookies } from "next/headers";

export async function POST(req: Request) {
  const raw = await req.text();

  const upstream =
    process.env.AIMER_GRAPHQL_ENDPOINT ??
    process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT ??
    "";

  if (!upstream) {
    return new Response(
      JSON.stringify({ error: "AIMER_GRAPHQL_ENDPOINT is not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // Allow opting out of TLS verification for self-signed local endpoints only.
  if (process.env.INSECURE_TLS === "1") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("aimer_token")?.value;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const upstreamResp = await fetch(upstream, {
    method: "POST",
    headers,
    body: raw,
    cache: "no-store",
  });

  const text = await upstreamResp.text();
  const ct = upstreamResp.headers.get("content-type") ?? "application/json";
  return new Response(text, {
    status: upstreamResp.status,
    headers: { "content-type": ct },
  });
}
