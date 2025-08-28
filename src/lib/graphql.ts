import { GraphQLClient } from "graphql-request";

const endpoint = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT;

if (!endpoint) {
  // eslint-disable-next-line no-console
  console.warn(
    "NEXT_PUBLIC_GRAPHQL_ENDPOINT is not set. Set it in your .env.local or environment.",
  );
}

export function getGqlClient(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new GraphQLClient(endpoint ?? "", { headers });
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
