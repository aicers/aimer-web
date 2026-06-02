# Configuration

This page will describe how to configure Clumit Insight.

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
| `KC_HOSTNAME` | Yes (production) | Canonical public URL Keycloak uses when building OIDC URLs (issuer, `redirect_uri`, password-reset links, account console). Must be a full URL with scheme — Keycloak 26 rejects a bare hostname when `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (which the prod profile forces). A public-path suffix is allowed and is required when the reverse proxy mounts Keycloak under a subpath; the bundled `nginx-prod` mounts it at `/auth`, so the bundled-proxy value is `https://aimer-web.example.com/auth`. No query, no trailing slash. The prod compose profile refuses to start without it. Pair with `EXPECTED_ORIGIN` so the BFF and Keycloak agree on the public origin (scheme + host + port). Examples: `https://aimer-web.example.com/auth` (bundled proxy), `https://aimer-web.example.com` (Keycloak at the apex), `https://auth.aimer-web.example.com` (Keycloak on its own host). | _(unset)_ |
| `KC_HTTP_RELATIVE_PATH` | No | Path prefix the Keycloak process itself listens on. The prod compose healthcheck appends this when probing the OIDC discovery endpoint, so it must match Keycloak's actual mount point. Leave at `/` when the reverse proxy strips the public prefix before proxying (the bundled `nginx-prod` strips `/auth/`, so Keycloak still sees `/`). Set to `/auth` (or another prefix) only when the proxy preserves the prefix end-to-end. The public-facing path lives in `KC_HOSTNAME`, not here. | `/` |
| `DATA_DIR` | No | Filesystem directory where next-app reads (and in dev writes) the session JWT signing key pair at `${DATA_DIR}/keys/ec-private.pem` (PKCS8) and `${DATA_DIR}/keys/ec-public.pem` (SPKI). In dev the BFF generates the pair on first start. In production the BFF refuses to start if either file is missing — operators must seed `${DATA_DIR}/keys/` with a pre-generated ES256 PEM pair before traffic reaches next-app. The prod compose profile pins this to `/app/data` and binds the `next-app-data` named volume there. See [Session JWT key persistence](#session-jwt-key-persistence) for the pre-generation recipe. | `./data` (prod compose: `/app/data`) |

## Production deployment notes

### Keycloak hostname and reverse proxy

In production, three settings together define the canonical public
URL Keycloak emits in OIDC payloads:

- `KC_HOSTNAME` pins the canonical public URL Keycloak uses to
  build every user-facing URL (issuer, `redirect_uri`,
  password-reset link, account console). It must be a full URL
  with scheme — Keycloak 26 rejects a bare hostname when
  `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` is `true`. The prod compose
  profile refuses to start without it. The URL may include a
  public-path suffix when the reverse proxy mounts Keycloak under
  a subpath; whatever path appears in `KC_HOSTNAME` is what
  Keycloak prepends to every browser-facing OIDC URL it emits.
  Pick the form that matches your proxy layout:
  - Bundled `nginx-prod`: use
    `https://aimer-web.example.com/auth` because nginx exposes
    Keycloak under `/auth/`.
  - Keycloak on its own hostname or at the apex of a dedicated
    proxy: use `https://auth.aimer-web.example.com` (no path).
- `KC_HOSTNAME_STRICT` is forced to `"true"` in the prod profile
  so Keycloak never derives URLs from incoming `Host` headers.
  This eliminates a class of hostname-drift bugs where users
  reaching Keycloak through a non-canonical hostname or
  port-forward see login forms, redirects, and email links
  pointing at the wrong host.
- `KC_HTTP_RELATIVE_PATH` is the path prefix the Keycloak process
  itself listens on, independent of the public path encoded in
  `KC_HOSTNAME`. Leave it at the default `/` when the reverse
  proxy strips the public prefix before proxying — the bundled
  `nginx-prod` strips `/auth/`, so Keycloak still receives
  requests at `/`. Set it to `/auth` (or another prefix) only
  when the proxy preserves that prefix end-to-end to Keycloak.
  The prod compose healthcheck appends this value to the probe
  URL, so it must match what Keycloak actually serves.

The bundled `nginx-prod` terminates TLS and proxies HTTP to
`keycloak-prod:8080`, so the prod profile sets
`KC_HTTP_ENABLED=true` on `keycloak-prod` to let it listen on
HTTP. The reverse proxy still presents HTTPS to clients and
forwards `X-Forwarded-Proto=https`, so OIDC URLs Keycloak emits
keep the `https://` scheme from `KC_HOSTNAME`.

`KEYCLOAK_URL` is a different setting: it is the BFF → Keycloak
URL used for server-to-server discovery and token exchange,
typically the in-cluster address. For the bundled prod profile the
recommended value is `http://keycloak-prod:8080` — the internal
compose address with no path suffix, since the prod profile leaves
`KC_HTTP_RELATIVE_PATH=/`. If `KC_HTTP_RELATIVE_PATH` is customized,
the path component of `KEYCLOAK_URL` must match it. `KC_HOSTNAME`
is Keycloak's view of its own public URL, used when Keycloak emits
browser-facing URLs. They must point at the same realm but rarely
share a value.

Do not point `KEYCLOAK_URL` at the public proxy URL (the value of
`KC_HOSTNAME`). With `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (which
the prod profile forces), Keycloak resolves backchannel URLs from
the incoming `Host` header plus `KC_HTTP_RELATIVE_PATH`. If the BFF
fetches discovery through the public proxy URL, the returned
document is _split_: the frontchannel URLs (`issuer`,
`authorization_endpoint`) carry the public `/auth` prefix, while
the backchannel URLs (`token_endpoint`, `jwks_uri`) do not. The BFF
then POSTs the authorization code to a path nginx routes to
`next-app`, and sign-in fails at `token_exchange_failed`. Keeping
`KEYCLOAK_URL` on the internal address avoids the split entirely.

`EXPECTED_ORIGIN` is the BFF's canonical public origin (scheme +
host + port) and must agree with the origin component of
`KC_HOSTNAME` so the BFF and Keycloak emit consistent URLs.
`EXPECTED_ORIGIN` is origin-only (path / query / hash are
rejected), while `KC_HOSTNAME` may include the public path the
proxy mounts Keycloak under — for the bundled `nginx-prod`,
`EXPECTED_ORIGIN=https://aimer-web.example.com` pairs with
`KC_HOSTNAME=https://aimer-web.example.com/auth`. With
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (also forced by the prod
profile), Keycloak still resolves the BFF's backchannel-only URLs
from forwarded headers, which is the correct behavior behind a
reverse proxy.

### Session JWT key persistence

next-app signs every session cookie with an ES256 key pair stored
at `${DATA_DIR}/keys/ec-private.pem` (PKCS8 PEM) and
`${DATA_DIR}/keys/ec-public.pem` (SPKI PEM). In dev the BFF
generates the pair on first start. In production the BFF refuses
to start if either file is missing — the keys must already exist
in `${DATA_DIR}/keys/` before traffic reaches next-app. This is
intentional: silent regeneration in production would invalidate
every issued session cookie at the worst possible moment.

In the prod compose profile `DATA_DIR` is pinned to `/app/data`
and bound to the `next-app-data` named volume (Compose scopes the
on-disk name with the project name, e.g.
`aimer-web_next-app-data`), so the key pair survives
`docker compose --profile prod up -d --force-recreate next-app`.
If the volume is destroyed the next prod start fails until the
keys are re-seeded — they will not be auto-regenerated. Operators
who prefer a bind mount can mount any host path onto `/app/data`
instead; the named volume is the default because it removes the
host-side setup step.

#### Pre-generating the keys for a fresh deploy

The keys must be a P-256 EC pair: PKCS8 PEM for the private half,
SPKI PEM for the public half. Generate them on the host with
openssl:

```sh
mkdir -p ./data/keys
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -out ./data/keys/ec-private.pem
openssl pkey -in ./data/keys/ec-private.pem -pubout \
  -out ./data/keys/ec-public.pem
```

Then seed them into the compose-managed volume so next-app finds
them at `/app/data/keys/`. Running the seeding step through
`docker compose run` lets Compose resolve the project-scoped
volume name automatically — no need to know it on the host.
`openssl genpkey` writes the private key as mode `0600` owned by
the host user, so the seeding container must run as root
(`--user 0`) to read the bind mount, and then `install` the
files into the volume with the runtime user/group (UID 1001,
GID 1001 — `nextjs:nodejs` from the Dockerfile) so next-app can
read them after `--user` resets back to `nextjs` on the next
start:

```sh
docker compose --profile prod run --rm --no-deps \
  -v "$PWD/data/keys:/src:ro" \
  --user 0 \
  --entrypoint sh next-app \
  -c '
    mkdir -p /app/data/keys &&
    install -o 1001 -g 1001 -m 600 /src/ec-private.pem /app/data/keys/ec-private.pem &&
    install -o 1001 -g 1001 -m 644 /src/ec-public.pem  /app/data/keys/ec-public.pem
  '
```

After that, `docker compose --profile prod up -d` starts cleanly.
Back the host-side `./data/keys/` directory up so you can recover
from accidental volume destruction; rotating the keys in place
invalidates every active session.

### Migration note

Deployments started before this hardening pass relied on
`KC_HOSTNAME_STRICT=false` and had no persisted `DATA_DIR`
volume. Before upgrading:

1. Set `KC_HOSTNAME` in `.env` to the canonical public URL with
   scheme and the public path your proxy mounts Keycloak under
   (bundled `nginx-prod`: `https://aimer-web.example.com/auth`;
   apex / dedicated host: `https://aimer-web.example.com` or
   `https://auth.aimer-web.example.com`). No trailing slash. The
   prod profile fails fast without it.
2. Confirm the reverse proxy forwards a stable `Host` header
   matching `KC_HOSTNAME` and sets `X-Forwarded-*` headers
   (the bundled `nginx-prod` does both).
3. Seed the new `next-app-data` named volume with the existing
   deployment's `${DATA_DIR}/keys/` contents before the first
   `up --force-recreate`; otherwise the BFF will refuse to start
   in production. Use the same `docker compose run` seeding
   recipe shown above, pointing its bind-mount source at the
   previous deployment's `${DATA_DIR}/keys/`. Restoring is a
   one-time step — once the keys live in the named volume, future
   recreates leave them alone.
