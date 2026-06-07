# Tier-2 E2E (full-flow analyst invitation)

These specs (`@tier2`-tagged) exercise the **real** analyst invitation
acceptance path — admin sends → invited user clicks the email link → real
Keycloak OIDC sign-in → designation (#452, Discussion #9 items 42 / 42-1).

Unlike the rest of the suite they need a full stack: **Keycloak** (real OIDC,
no cookie-injection shortcut on the acceptance step) and **Mailpit** (capture
the invitation email, follow the real link), in addition to Postgres + OpenBao.

They are **excluded from the per-PR pipeline**. The default `chromium` project
in `e2e/playwright.config.ts` uses `grepInvert: /@tier2/`, so `pnpm test:e2e`
never touches them. They run only via the `tier2-chromium` project.

## Run in CI

`.github/workflows/e2e-nightly.yml` runs them on a **KST-midnight** cron
(`15 15 * * *` UTC ≈ 00:15 KST), gated to proceed only when `main` received
commits during the previous KST day. To validate the workflow on demand,
trigger it via **`workflow_dispatch`** (Actions → "E2E Nightly (Tier-2)" → Run
workflow) — a manual run always proceeds, bypassing the date gate.

## Run locally

```sh
# 1. Bring up the dev stack (provides Keycloak + Mailpit + Postgres + OpenBao).
docker compose --profile dev up -d postgres openbao keycloak mailpit

# 2. Seed the Keycloak test users (idempotent).
bash infra/keycloak/seed-test-users.sh

# 3. Run the Tier-2 project. The keys below already exist in .env.example;
#    SMTP must point at Mailpit so the invitation email is captured.
SMTP_HOST=localhost SMTP_PORT=1025 EMAIL_FROM=e2e@aimer-web.test \
MAILPIT_API_URL=http://localhost:8025 \
pnpm test:e2e:tier2
```

The seeded users (`invited-success@e2e.test`, `invited-mismatch@e2e.test`) get
`emailVerified=true`, a fixed password (`E2E_USER_PASSWORD`, default
`e2e-Passw0rd!`), and no required actions, so the Keycloak login never stalls
on an interstitial.
