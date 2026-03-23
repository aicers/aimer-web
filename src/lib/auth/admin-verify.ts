import type { IdTokenClaims } from "./oidc-validate";

/**
 * Verify admin-specific claims from the ID token.
 * Returns null on success, or a deny reason string on failure.
 */
export function verifyAdminClaims(
  idClaims: IdTokenClaims,
  accountAdminEligible: boolean,
): string | null {
  // acr claim — fail-closed
  const acceptedAcr = (
    process.env.ADMIN_ACCEPTED_ACR_VALUES ??
    "urn:keycloak:acr:mfa,urn:keycloak:acr:2fa"
  ).split(",");

  if (!idClaims.acr || !acceptedAcr.includes(idClaims.acr)) {
    return "admin_mfa_required";
  }

  // auth_time — fail-closed
  const maxAuthAge = Number(process.env.ADMIN_MAX_AUTH_AGE_SECONDS) || 300;
  const now = Math.floor(Date.now() / 1000);

  if (!idClaims.auth_time || now - idClaims.auth_time > maxAuthAge) {
    return "admin_auth_too_old";
  }

  // aimer_admin realm role
  if (!idClaims.realm_access?.roles?.includes("aimer_admin")) {
    return "admin_role_missing";
  }

  // admin_eligible flag on account
  if (!accountAdminEligible) {
    return "admin_not_eligible";
  }

  return null;
}
