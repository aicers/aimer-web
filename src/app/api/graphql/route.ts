import { cookies } from "next/headers";

type GraphQLPayload =
  | { query?: string; operationName?: string | null }
  | Array<{ query?: string; operationName?: string | null }>;

function isSignInOperation(body: unknown): boolean {
  try {
    const payload = body as GraphQLPayload;
    const check = (op?: { query?: string; operationName?: string | null }) => {
      const opName = (op?.operationName || "").toString();
      if (opName === "SignIn") return true;
      const q = (op?.query || "").toString();
      // Heuristic: look for a mutation operation explicitly named SignIn
      // e.g., "mutation SignIn($u: String!) { signIn ... }"
      if (/mutation\s+SignIn\b/i.test(q)) return true;
      return false;
    };
    if (Array.isArray(payload)) return payload.some((op) => check(op));
    return check(payload as { query?: string; operationName?: string | null });
  } catch {
    return false;
  }
}

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

  // Decide whether to attach Authorization based on the operation.
  let attachAuth = true;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isSignInOperation(parsed)) attachAuth = false;
  } catch {
    // If body is not JSON, fall back to default behavior (attach if present)
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (attachAuth) {
    const cookieStore = await cookies();
    const token = cookieStore.get("aimer_token")?.value;
    if (token) headers.Authorization = `Bearer ${token}`;
  }

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
