import "server-only";

import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { GraphQLClient } from "graphql-request";
import type { Agent } from "undici";
import { fetch as undiciFetch } from "undici";

import { createMtlsRequestAuth } from "@/lib/mtls";

function buildClient(endpoint: string, agent: Agent): GraphQLClient {
  return new GraphQLClient(endpoint, {
    fetch: async (input, init) => {
      // `undici.fetch`'s Response is structurally compatible with the WHATWG
      // Response that `graphql-request` consumes, but the TypeScript types do
      // not overlap. Keep the cast scoped to this adapter so it does not leak
      // into the public surface.
      return (await undiciFetch(
        input as string | URL,
        { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1],
      )) as unknown as Response;
    },
  });
}

function getAimerEndpoint(): string {
  const endpoint = process.env.AIMER_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error("Missing environment variable: AIMER_GRAPHQL_ENDPOINT");
  }
  return endpoint;
}

interface RequestContext {
  accountId: string;
  aiceId: string;
}

/**
 * Dispatch a GraphQL request to aimer through the mTLS-authenticated undici
 * dispatcher with a freshly-signed Context JWT attached as a Bearer token.
 *
 * The agent and JWT are read from the same `mtls` snapshot via
 * `createMtlsRequestAuth`, and the snapshot's lease is held for the lifetime
 * of the dispatch (released in `finally`). This closes the JWT/cert pairing
 * race and the "agent gets closed mid-request" race during cert rotation.
 *
 * `ctx.accountId → sub`, `ctx.aiceId → aice_id`. No `customer_ids` claim:
 * aimer is stateless, so customer authorization lives entirely on the BFF
 * route layer. The endpoint is read lazily (and validated before the lease
 * is acquired) so a misconfigured environment does not pointlessly acquire
 * and immediately release a snapshot lease.
 */
export async function graphqlRequest<
  TResult,
  TVariables extends Record<string, unknown> = Record<string, never>,
>(
  document: TypedDocumentNode<TResult, TVariables>,
  variables: TVariables | undefined,
  ctx: RequestContext,
  options?: { signal?: AbortSignal },
): Promise<TResult> {
  // Defense-in-depth: the TypeScript signature rejects strings, but a runtime
  // check guards against `as unknown as TypedDocumentNode<...>` casts that
  // smuggle one through. All queries must be parsed DocumentNodes so a future
  // schema-validation step can validate them against the vendored aimer SDL.
  if (typeof document === "string") {
    throw new TypeError(
      "graphqlRequest: raw query strings are not allowed. Keep queries in " +
        "a checked-in .graphql file (validated by CI) and parse them with " +
        "`parse()` or import them through graphql-codegen.",
    );
  }

  const endpoint = getAimerEndpoint();

  const { agent, token, release } = await createMtlsRequestAuth({
    sub: ctx.accountId,
    aice_id: ctx.aiceId,
  });
  try {
    const gqlClient = buildClient(endpoint, agent);
    return await gqlClient.request<TResult>({
      document,
      variables,
      requestHeaders: {
        Authorization: `Bearer ${token}`,
      },
      signal: options?.signal,
    });
  } finally {
    release();
  }
}
