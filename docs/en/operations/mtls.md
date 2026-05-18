# mTLS

This page is for operators. It describes the end-to-end setup that
makes aimer-web talk to the aimer backend over mutual TLS: how
certificates are provisioned, which environment variables aimer-web
reads, how to trigger a hot reload after rotation, and what log lines
to alert on for expiry and reload outcomes.

mTLS is **not** a client-only feature. aimer-web is the client; the
aimer backend is the server. An operator following only the
aimer-web steps cannot bring the channel up. For the server-side
configuration (the `auth-mtls` Cargo feature, listener setup, and
SIGHUP behavior on aimer) see the aimer operator documentation; if
those pages have not yet been published, the work is tracked under
the umbrella issue
<https://github.com/aicers/aimer/issues/358> and the aimer SIGHUP
docs land via
<https://github.com/aicers/aimer/issues/367>.

<!-- TODO(#231): replace the cross-repo umbrella links above with
deep links to the aimer operator pages once they are published. -->

## End-to-end setup checklist

Follow these steps top-to-bottom on a fresh deployment. Steps 1–4
bring the pipe up; step 5 is the cross-version smoke test that
proves the wiring is correct.

1. **bootroot provisions the certificate pair** (cert + key + CA) on
   both the aimer-web host and the aimer host. aimer-web accepts
   bootroot's private-key output in any of the three PEM formats
   bootroot may emit — PKCS#8 (`-----BEGIN PRIVATE KEY-----`),
   PKCS#1 RSA (`-----BEGIN RSA PRIVATE KEY-----`), and SEC1 EC
   (`-----BEGIN EC PRIVATE KEY-----`). No operator action is
   required to convert between them; aimer-web normalizes to PKCS#8
   internally. (Recorded here so a future bootroot format change has
   a documented anchor.)
2. **Build aimer with the `auth-mtls` Cargo feature.** This is the
   opt-in server build tracked under
   <https://github.com/aicers/aimer/issues/358>. Configure the
   server-side listener per the aimer operator documentation.
3. **Configure aimer-web** by setting the environment variables in
   the [Environment variables](#environment-variables) section
   below. The same cert/key pair is used for both the TLS handshake
   and for signing the per-request JWT — there is no separate
   signing key.
4. **(Optional smoke test) Trigger a SIGHUP on both sides** to
   verify the reload path works. The aimer-web SIGHUP handler is
   auto-registered by `src/instrumentation.ts` at boot and the cert
   is loaded lazily on first request, so this step verifies reload
   rather than being required for first-time setup. See
   [Reloading after rotation](#reloading-after-rotation).
5. **Run the cross-version smoke test** (verification item 41 from
   <https://github.com/aicers/aimer-web/discussions/9>): make an
   mTLS-routed GraphQL request against an `auth-mtls` aimer build
   and assert the JWT contract — `aud = "aimer"`,
   `exp - iat = 300`, and **no `customer_ids` claim**. This step
   requires a live `auth-mtls` aimer build and is part of the
   feature-complete deliverable under
   <https://github.com/aicers/aimer-web/issues/44>; it is documented
   here for operator reference, not as a prerequisite for pipe
   acceptance.

## Environment variables

| Name | Required | Description | Default |
| --- | --- | --- | --- |
| `MTLS_CERT_PATH` | Yes | Filesystem path to the client certificate PEM provisioned by bootroot. | _(unset; aimer-web refuses to start the mTLS state)_ |
| `MTLS_KEY_PATH` | Yes | Filesystem path to the private key PEM that pairs with `MTLS_CERT_PATH`. PKCS#8, PKCS#1 RSA, and SEC1 EC are all accepted. | _(unset; aimer-web refuses to start the mTLS state)_ |
| `MTLS_CA_PATH` | Yes | Filesystem path to the CA bundle PEM that validates the aimer server certificate. | _(unset; aimer-web refuses to start the mTLS state)_ |
| `AIMER_GRAPHQL_ENDPOINT` | Yes | URL of the aimer GraphQL endpoint (e.g. `https://aimer.internal/graphql`). | _(unset; the mTLS-routed client refuses to dispatch)_ |

The three `MTLS_*` paths are read by `src/lib/mtls.ts` on first
request (lazy init) and re-read on every SIGHUP — rotating the cert
files and signalling the process picks up the new values without a
restart.

`AIMER_GRAPHQL_ENDPOINT` is read from `process.env` on every
dispatch by `src/lib/graphql/client.ts` and is **not** part of the
SIGHUP reload path. Changing the endpoint in a service env file
requires restarting the aimer-web process — SIGHUP will not pick it
up the way it does for rotated certificate files.

There is no separate config file: the environment is the source of
truth.

The same cert pair drives both legs of the conversation: it is the
client certificate for the TLS handshake, **and** it is the signing
key for the JWT aimer-web mints on every request. Rotating one
rotates the other.

### JWT contract

The token aimer-web signs and sends on each request carries:

- `sub` — the account id of the calling user.
- `aice_id` — the AICE identity associated with the call.
- `aud = "aimer"` — fixed in code; **not configurable**.
- `exp = iat + 300` — fixed 5-minute lifetime.
- `jti` — random UUID per request.
- **No `customer_ids` claim.** Customer authorization is enforced by
  aimer-web's BFF route layer **before** the call is made, not by
  the JWT itself. Operators changing environment variables cannot
  affect this contract.

## Supported certificate algorithms

aimer-web detects the certificate's algorithm from its public key
and signs the JWT with a matching algorithm:

| Public key | Algorithm |
| --- | --- |
| RSA, ≥ 4096-bit modulus | `RS512` |
| RSA, ≥ 3072-bit modulus | `RS384` |
| RSA, smaller modulus | `RS256` |
| EC, `prime256v1` (P-256) | `ES256` |
| EC, `secp384r1` (P-384) | `ES384` |

**ES512 (EC P-521) is intentionally unsupported.** If bootroot is
configured to emit a P-521 client certificate, aimer-web fails to
build the mTLS state with a clear error
(`Unsupported EC curve: secp521r1`). Do not deploy P-521 certs
without first widening this list in code.

## Certificate layout expectations

bootroot writes the three PEM files to filesystem paths the operator
selects. The recommended layout, used by the systemd / k8s examples
below, is:

| File | Ownership | Mode | Purpose |
| --- | --- | --- | --- |
| `<dir>/client.crt` | `aimer-web:aimer-web` | `0644` | Client certificate (`MTLS_CERT_PATH`) |
| `<dir>/client.key` | `aimer-web:aimer-web` | `0600` | Private key (`MTLS_KEY_PATH`) |
| `<dir>/ca.crt` | `aimer-web:aimer-web` | `0644` | CA bundle for verifying aimer (`MTLS_CA_PATH`) |

The private key must be readable only by the aimer-web service
account. The cert and CA bundle may be world-readable. bootroot
rotates these files in place; aimer-web does not watch the
filesystem, so a rotation is not picked up until SIGHUP (see below).

## Reloading after rotation

aimer-web installs a SIGHUP handler at boot via
`src/instrumentation.ts`. The handler is registered in
`src/lib/instrumentation/mtls-sighup.ts` and calls
`reload()` in `src/lib/mtls.ts`, which:

- re-reads the three PEM files from the same env-var paths,
- builds a new TLS agent and a new JWT signing key,
- atomically swaps the new state in,
- retires the previous agent, draining it after the last in-flight
  request finishes.

There is no downtime and no dropped request across the swap.

### Which PID to signal

bootroot rotates files **on each host**, and each Node process
holds its own in-memory cert state. Signal every Node process that
serves traffic — not just one.

- **Bare Node (`pnpm start` / `next start`):** signal the parent
  `next` process. Example: `kill -HUP $(pgrep -f 'next start')`.
- **Next.js standalone build (`output: "standalone"`):** signal the
  `node server.js` process inside the standalone bundle.
- **Container:** signal PID 1 inside the container, e.g.
  `kill -HUP 1` (or `docker kill -s HUP <container>` /
  `kubectl exec <pod> -- kill -HUP 1`).
- **Node cluster mode / pm2 cluster / multiple replicas:** signal
  **every** worker and **every** replica. For pm2 cluster mode,
  `pm2 reload <app>` re-signals each worker. For a Kubernetes
  Deployment with N replicas, iterate over all pods.

### systemd

A typical unit has:

```ini
[Service]
ExecStart=/usr/bin/node /opt/aimer-web/server.js
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGTERM
```

After bootroot rotates the certs, the rotation hook runs
`systemctl reload aimer-web`.

### Kubernetes

Kubernetes does **not** fire a lifecycle hook when a mounted Secret
or ConfigMap is rotated — `postStart` runs once on container start
and `preStop` runs on shutdown. Reload must therefore be driven
out-of-band by something that notices the new cert files and signals
every pod.

Two supported approaches:

1. **`kubectl exec` loop driven by the rotator** (simplest). After
   bootroot updates the mounted Secret, the rotator job runs:

   ```sh
   kubectl get pods -l app=aimer-web -o name \
     | xargs -I{} kubectl exec {} -- kill -HUP 1
   ```

   Iterating over **every** pod is required — each Node process holds
   its own in-memory cert state.

2. **Sidecar watcher in the pod spec.** A small sidecar container
   shares the cert volume, watches the mounted files with `inotify`
   (or polls), and runs `kill -HUP 1` against the main container via
   a shared process namespace (`shareProcessNamespace: true`). This
   keeps the reload trigger inside the pod and avoids needing
   cluster-wide `pods/exec` permissions on the rotator job.

Whichever approach is used, signal every replica of the Deployment —
bootroot rotates files on each node, and a partially-reloaded
Deployment leaves some pods serving with the old cert.

### aimer

To rotate certs on the server side, follow the aimer SIGHUP
procedure documented under
<https://github.com/aicers/aimer/issues/367>. aimer-web and aimer
reload independently; rotating only one side leaves the channel in
a mismatched state.

## Log formats

The strings below are emitted verbatim by `src/lib/mtls.ts` and
`src/lib/instrumentation/mtls-sighup.ts`. Alert rules grepping for
them must match these strings exactly.

### Expiry monitor

aimer-web checks the loaded certificate's expiry every 6 hours and
on every reload. Within 3 days of expiry it emits a warn line at
most once per 24h per fingerprint; once expired it emits an error
line under the same rate limit.

- Warn (within 3 days):
  `[mtls] client certificate expires in <N> day(s) at <ISO-timestamp> (fingerprint <hex>)`
- Error (already expired):
  `[mtls] client certificate has EXPIRED at <ISO-timestamp> (fingerprint <hex>)`

aimer emits its own expiry warnings independently. Operators must
monitor both sides — a near-expiry cert on the server is not
visible from aimer-web's logs.

### SIGHUP reload

Emitted by the SIGHUP handler after every signal:

- Success: `[mtls] SIGHUP: reloaded mTLS materials`
- Failure: `[mtls] SIGHUP: reload failed <error>`

A failed reload leaves the previous state in place; aimer-web keeps
serving with the old cert until the next successful reload or
restart.
