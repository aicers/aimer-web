import { GraphQLClient } from "graphql-request";

function resolveEndpoint(): string {
  const ep = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT;
  if (!ep) throw new Error("NEXT_PUBLIC_GRAPHQL_ENDPOINT is not set");
  if (ep.startsWith("/")) {
    if (typeof window !== "undefined") {
      return new URL(ep, window.location.origin).toString();
    }
    // SSR fallback: best-effort base URL
    const base =
      process.env.NEXT_PUBLIC_BASE_URL ||
      `http://localhost:${process.env.PORT || 3000}`;
    return new URL(ep, base).toString();
  }
  return ep;
}

export function getGqlClient(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = resolveEndpoint();
  return new GraphQLClient(url, { headers });
}

export type SignInResult = { token: string };

// signIn mutation per provided schema
const SIGN_IN_MUTATION = /* GraphQL */ `
  mutation SignIn($username: String!, $password: String!) {
    signIn(username: $username, password: $password) {
      token
    }
  }
`;

export async function signInRequest(params: {
  username: string;
  password: string;
}): Promise<SignInResult> {
  type Response = { signIn: { token: string } };
  const client = getGqlClient();
  const data = await client.request<Response>(SIGN_IN_MUTATION, params);
  return data.signIn;
}
