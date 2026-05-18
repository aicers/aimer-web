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
