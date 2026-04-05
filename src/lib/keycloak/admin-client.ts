/**
 * Keycloak Admin REST API client for realm role management.
 *
 * Uses the client_credentials grant to obtain an access token from a
 * dedicated service-account client, then calls the Admin REST API to
 * assign or remove the `aimer_admin` realm role.
 *
 * The service-account client must be a confidential client in Keycloak
 * with "Service Account Enabled" and the "realm-admin" role assigned to
 * its service account.  Do NOT use "admin-cli" — it does not support
 * the client_credentials grant by default.
 *
 * Required environment variables:
 *   KEYCLOAK_URL                 — e.g. http://localhost:8080
 *   KEYCLOAK_REALM               — e.g. aimer
 *   KEYCLOAK_ADMIN_CLIENT_ID     — service-account client ID
 *   KEYCLOAK_ADMIN_CLIENT_SECRET — service-account client secret
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KeycloakRoleRepresentation {
  id: string;
  name: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getKeycloakUrl(): string {
  const url = process.env.KEYCLOAK_URL;
  if (!url) throw new Error("KEYCLOAK_URL is not set");
  return url.replace(/\/+$/, "");
}

function getRealm(): string {
  const realm = process.env.KEYCLOAK_REALM;
  if (!realm) throw new Error("KEYCLOAK_REALM is not set");
  return realm;
}

function getAdminClientId(): string {
  const id = process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  if (!id) throw new Error("KEYCLOAK_ADMIN_CLIENT_ID is not set");
  return id;
}

function getAdminClientSecret(): string {
  const secret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  if (!secret) throw new Error("KEYCLOAK_ADMIN_CLIENT_SECRET is not set");
  return secret;
}

// ---------------------------------------------------------------------------
// Token cache (module-level, short TTL)
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  const now = Date.now();
  // Refresh 30 seconds before expiry
  if (cachedToken && now < cachedTokenExpiry - 30_000) {
    return cachedToken;
  }

  const base = getKeycloakUrl();
  const realm = getRealm();
  const url = `${base}/realms/${realm}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: getAdminClientId(),
    client_secret: getAdminClientSecret(),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Keycloak token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  cachedToken = data.access_token;
  cachedTokenExpiry = now + data.expires_in * 1000;
  return cachedToken;
}

// ---------------------------------------------------------------------------
// Admin REST API helpers
// ---------------------------------------------------------------------------

async function adminFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const token = await getAdminToken();
  const base = getKeycloakUrl();
  const realm = getRealm();
  const url = `${base}/admin/realms/${realm}${path}`;

  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ADMIN_ROLE_NAME = "aimer_admin";

/**
 * Fetch the `aimer_admin` realm role representation (id + name).
 * Throws if the role does not exist in Keycloak.
 */
async function getAdminRole(): Promise<KeycloakRoleRepresentation> {
  const res = await adminFetch(`/roles/${ADMIN_ROLE_NAME}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Keycloak role '${ADMIN_ROLE_NAME}' (${res.status})`,
    );
  }
  return res.json() as Promise<KeycloakRoleRepresentation>;
}

/**
 * Assign the `aimer_admin` realm role to a Keycloak user.
 *
 * @param keycloakUserId — the Keycloak user ID (= oidc_subject in our DB)
 */
export async function assignAdminRole(keycloakUserId: string): Promise<void> {
  const role = await getAdminRole();
  const res = await adminFetch(`/users/${keycloakUserId}/role-mappings/realm`, {
    method: "POST",
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to assign Keycloak role '${ADMIN_ROLE_NAME}' to user ${keycloakUserId} (${res.status}): ${text}`,
    );
  }
}

/**
 * Remove the `aimer_admin` realm role from a Keycloak user.
 *
 * @param keycloakUserId — the Keycloak user ID (= oidc_subject in our DB)
 */
export async function removeAdminRole(keycloakUserId: string): Promise<void> {
  const role = await getAdminRole();
  const res = await adminFetch(`/users/${keycloakUserId}/role-mappings/realm`, {
    method: "DELETE",
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to remove Keycloak role '${ADMIN_ROLE_NAME}' from user ${keycloakUserId} (${res.status}): ${text}`,
    );
  }
}
