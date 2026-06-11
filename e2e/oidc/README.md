# OIDC E2E (full-flow analyst invitation)

These specs (`@oidc`-tagged) exercise the **real** analyst invitation
acceptance path — admin sends → invited user clicks the email link → real
Keycloak OIDC sign-in → designation (#452, Discussion #9 items 42 / 42-1).

They are the only specs that go through a real OIDC sign-in; the rest of the
suite shortcuts auth via JWT cookie injection. So unlike the rest they need a
full stack: **Keycloak** (real OIDC, no cookie-injection shortcut on the
acceptance step) and **Mailpit** (capture the invitation email, follow the real
link), in addition to Postgres + OpenBao.

They are **excluded from the main `e2e` job**. The default `chromium` project
in `e2e/playwright.config.ts` uses `grepInvert: /@oidc/`, so `pnpm test:e2e`
never touches them. They run only via the `oidc-chromium` project.

## Run in CI

The **`E2E OIDC`** job in `.github/workflows/ci.yml` runs them on every PR,
concurrently with the main `e2e` job (both gated behind `check`). It stands up
Keycloak + Mailpit alongside Postgres + OpenBao and runs `pnpm test:e2e:oidc`.
Because it runs in parallel with the rest of the suite, it adds no critical-path
wall-clock while giving each PR full-flow coverage.

## Run locally

```sh
# 1. Bring up the dev stack (provides Keycloak + Mailpit + Postgres + OpenBao).
docker compose --profile dev up -d postgres openbao keycloak mailpit

# 2. Seed the Keycloak test users (idempotent).
bash infra/keycloak/seed-test-users.sh

# 3. Run the OIDC project. The keys below already exist in .env.example;
#    SMTP must point at Mailpit so the invitation email is captured.
SMTP_HOST=localhost SMTP_PORT=1025 EMAIL_FROM=e2e@aimer-web.test \
MAILPIT_API_URL=http://localhost:8025 \
pnpm test:e2e:oidc
```

The seeded users (`invited-success@e2e.test`, `invited-mismatch@e2e.test`) get
`emailVerified=true`, a fixed password (`E2E_USER_PASSWORD`, default
`e2e-Passw0rd!`), and no required actions, so the Keycloak login never stalls
on an interstitial.
