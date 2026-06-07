#!/usr/bin/env bash
#
# Seed Keycloak test users for the Tier-2 nightly E2E (#452).
#
# The shared realm export (infra/keycloak/realm-export.json) defines clients +
# roles but intentionally has NO users — it is also imported by the prod
# Keycloak profile, so test accounts must never live in it. This script
# provisions the test users at runtime via the Keycloak Admin REST API.
#
# Idempotent: an existing user with the same email is deleted and recreated.
#
# Required login-readiness for each user (so Playwright never stalls on a
# Keycloak interstitial): enabled, emailVerified, a fixed non-temporary
# password, and no required actions.
#
# Env (with defaults for the docker-compose dev / CI stack):
#   KEYCLOAK_URL          base URL                (default http://localhost:8080)
#   KEYCLOAK_REALM        target realm            (default aimer)
#   KEYCLOAK_ADMIN        master-realm admin user (default admin)
#   KEYCLOAK_ADMIN_PASSWORD admin password        (default admin)
#   E2E_USER_PASSWORD     password for all seeded users (default e2e-Passw0rd!)
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${KEYCLOAK_REALM:-aimer}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
USER_PASSWORD="${E2E_USER_PASSWORD:-e2e-Passw0rd!}"

# The two users the specs require. Keep emails in sync with the Tier-2 specs.
USERS=(
  "invited-success@e2e.test"
  "invited-mismatch@e2e.test"
)

echo "[seed] obtaining admin token from ${KEYCLOAK_URL} (master realm)"
TOKEN="$(curl -sf \
  -d "client_id=admin-cli" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASS}" \
  -d "grant_type=password" \
  "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  | jq -r '.access_token')"

if [[ -z "${TOKEN}" || "${TOKEN}" == "null" ]]; then
  echo "[seed] ERROR: failed to obtain admin token" >&2
  exit 1
fi

auth_header="Authorization: Bearer ${TOKEN}"

delete_if_exists() {
  local email="$1"
  local existing
  existing="$(curl -sf -H "${auth_header}" \
    "${KEYCLOAK_URL}/admin/realms/${REALM}/users?email=$(jq -rn --arg e "${email}" '$e|@uri')&exact=true" \
    | jq -r '.[0].id // empty')"
  if [[ -n "${existing}" ]]; then
    echo "[seed] deleting existing user ${email} (${existing})"
    curl -sf -X DELETE -H "${auth_header}" \
      "${KEYCLOAK_URL}/admin/realms/${REALM}/users/${existing}"
  fi
}

create_user() {
  local email="$1"
  echo "[seed] creating user ${email}"
  curl -sf -X POST -H "${auth_header}" -H "Content-Type: application/json" \
    "${KEYCLOAK_URL}/admin/realms/${REALM}/users" \
    -d "$(jq -n \
      --arg email "${email}" \
      '{
        username: $email,
        email: $email,
        firstName: "E2E",
        lastName: "Tester",
        enabled: true,
        emailVerified: true,
        requiredActions: []
      }')"
}

set_password() {
  local email="$1"
  local id
  id="$(curl -sf -H "${auth_header}" \
    "${KEYCLOAK_URL}/admin/realms/${REALM}/users?email=$(jq -rn --arg e "${email}" '$e|@uri')&exact=true" \
    | jq -r '.[0].id // empty')"
  if [[ -z "${id}" ]]; then
    echo "[seed] ERROR: user ${email} not found after create" >&2
    exit 1
  fi
  echo "[seed] setting non-temporary password for ${email} (${id})"
  # Use reset-password (not inline credentials on create): the latter can be
  # stored as temporary, which forces an "Update password" interstitial that
  # blocks the automated login.
  curl -sf -X PUT -H "${auth_header}" -H "Content-Type: application/json" \
    "${KEYCLOAK_URL}/admin/realms/${REALM}/users/${id}/reset-password" \
    -d "$(jq -n --arg pass "${USER_PASSWORD}" \
      '{ type: "password", value: $pass, temporary: false }')"
}

for email in "${USERS[@]}"; do
  delete_if_exists "${email}"
  create_user "${email}"
  set_password "${email}"
done

echo "[seed] done — seeded ${#USERS[@]} user(s) in realm '${REALM}'"
