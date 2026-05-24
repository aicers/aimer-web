# Configuration

This page will describe how to configure Aimer Web.

## Environment variables

aimer-web reads its configuration from process environment
variables. The table below lists the variables this page documents
so far; follow-up issues will append additional sections to the
same 4-column shape (`Name | Required | Description | Default`).

| Name | Required | Description | Default |
| --- | --- | --- | --- |
| `MTLS_CERT_PATH` | Yes | Filesystem path to the client certificate PEM used for mTLS to the aimer backend. Its public key determines the JWT signing algorithm and supplies the fingerprint / expiry that the monitor reports. See [mTLS](operations/mtls.md). | _(unset)_ |
| `MTLS_KEY_PATH` | Yes | Filesystem path to the private key PEM that pairs with `MTLS_CERT_PATH`. This is the JWT signing key — aimer-web signs every outbound JWT with it. PKCS#8, PKCS#1 RSA, and SEC1 EC are all accepted. See [mTLS](operations/mtls.md). | _(unset)_ |
| `MTLS_CA_PATH` | Yes | Filesystem path to the CA bundle PEM that validates the aimer server certificate. See [mTLS](operations/mtls.md). | _(unset)_ |
| `AIMER_GRAPHQL_ENDPOINT` | Yes | URL of the aimer GraphQL endpoint (e.g. `https://aimer.internal/graphql`). The mTLS-routed GraphQL client refuses to dispatch if this is unset. | _(unset)_ |
| `EXPECTED_ORIGIN` | Yes (production) | Public canonical origin of the deployed BFF. Required in production because the BFF normally runs behind a reverse proxy and Next.js cannot infer the public origin from forwarded headers. Used to build OIDC `redirect_uri`, callback / logout URLs, invitation links, absolute redirects, and to validate the `Origin` header in CSRF checks. A trailing slash is allowed and is normalised away at startup; path, query, or hash components are rejected. Example: `https://aimer-web.example.com`. | _(unset)_ |
| `KC_HOSTNAME` | Yes (production) | Canonical public hostname Keycloak uses when building OIDC URLs (issuer, `redirect_uri`, password-reset links, account console). Must be the bare hostname — no scheme, no path, no trailing slash. The prod compose profile refuses to start without it. Pair with `EXPECTED_ORIGIN` so the BFF and Keycloak agree on the public URL. Example: `aimer-web.example.com`. | _(unset)_ |
| `KC_HTTP_RELATIVE_PATH` | No | Path prefix Keycloak is mounted at when the reverse proxy preserves the prefix during proxying. The prod compose healthcheck appends this when probing the OIDC discovery endpoint, so it must match Keycloak's actual mount point. Leave at `/` when the reverse proxy strips the prefix (the default for the bundled `nginx-prod`). Set to `/auth` (or another prefix) only when the prefix is preserved end-to-end. | `/` |
| `DATA_DIR` | No | Filesystem directory where next-app persists generated state — most importantly the session JWT signing key pair at `${DATA_DIR}/keys/ec-private.pem` and `${DATA_DIR}/keys/ec-public.pem`. These keys must persist across container restarts; recreating them invalidates every issued session cookie. The prod compose profile pins this to `/app/data` and binds the `next-app-data` named volume there; a documented operator-managed bind mount over the same path works as well. In production the BFF refuses to start if the keys are missing — they must be pre-generated or restored from a previous deploy. | `./data` (prod compose: `/app/data`) |

## Production deployment notes

### Keycloak hostname and reverse proxy

In production, three settings together define the canonical public
URL Keycloak emits in OIDC payloads:

- `KC_HOSTNAME` pins the hostname Keycloak uses to build every
  user-facing URL (issuer, `redirect_uri`, password-reset link,
  account console). The prod compose profile refuses to start
  without it.
- `KC_HOSTNAME_STRICT` is forced to `"true"` in the prod profile
  so Keycloak never derives URLs from incoming `Host` headers.
  This eliminates a class of hostname-drift bugs where users
  reaching Keycloak through a non-canonical hostname or
  port-forward see login forms, redirects, and email links
  pointing at the wrong host.
- `KC_HTTP_RELATIVE_PATH` matches the path prefix preserved by
  the reverse proxy. The default `/` is sufficient for the prod
  compose healthcheck. Set it to `/auth` (or another prefix)
  only when your reverse proxy preserves that prefix end-to-end
  to Keycloak; the bundled `nginx-prod` strips `/auth/` before
  proxying, so its healthcheck passes at `/` even though OIDC
  URLs would need a non-stripping proxy to be fully correct.

`KEYCLOAK_URL` is a different setting: it is the BFF → Keycloak
URL used for server-to-server discovery and token exchange,
typically the in-cluster address (e.g. `http://keycloak-prod:8080`).
`KC_HOSTNAME` is Keycloak's view of its own public URL, used
when Keycloak emits browser-facing URLs. They must point at the
same realm but rarely share a value.

`EXPECTED_ORIGIN` (the BFF-side equivalent of `KC_HOSTNAME`) must
agree with `KC_HOSTNAME` so the BFF and Keycloak emit consistent
URLs. With `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (also forced by
the prod profile), Keycloak still resolves the BFF's
backchannel-only URLs from forwarded headers, which is the
correct behavior behind a reverse proxy.

### Session JWT key persistence

next-app writes its session JWT key pair to
`${DATA_DIR}/keys/ec-private.pem` and
`${DATA_DIR}/keys/ec-public.pem` on first start. In production
`DATA_DIR` is pinned to `/app/data` and bound to the
`next-app-data` named volume, so the key pair survives
`docker compose --profile prod up -d --force-recreate next-app`.
If the volume is recreated (`docker volume rm next-app-data`)
the keys are regenerated and every issued session cookie becomes
invalid. Operators who prefer a bind mount can mount any host
path onto `/app/data` instead; the named volume is the default
because it removes the host-side setup step.

In production the BFF refuses to start if the key files are
missing — they must be pre-generated (or restored from a
previous deploy) before traffic reaches next-app.

### Migration note

Deployments started before this hardening pass relied on
`KC_HOSTNAME_STRICT=false` and had no persisted `DATA_DIR`
volume. Before upgrading:

1. Set `KC_HOSTNAME` in `.env` to the canonical public hostname
   (no scheme, no trailing slash). The prod profile fails fast
   without it.
2. Confirm the reverse proxy forwards a stable `Host` header
   matching `KC_HOSTNAME` and sets `X-Forwarded-*` headers
   (the bundled `nginx-prod` does both).
3. Copy any existing `${DATA_DIR}/keys/` contents into the new
   `next-app-data` named volume before the first
   `up --force-recreate`; otherwise the BFF will refuse to
   start in production. Named volumes are not writable from the
   host directly — seed them with a one-off helper container,
   e.g. (run from the compose project directory):

   ```sh
   docker volume create next-app-data
   docker run --rm \
     -v next-app-data:/dst \
     -v "$PWD/data/keys:/src:ro" \
     alpine sh -c 'mkdir -p /dst/keys && cp -a /src/. /dst/keys/'
   ```

   Restoring is a one-time step — once the keys live in the
   named volume, future recreates leave them alone.
