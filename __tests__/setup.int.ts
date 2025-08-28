// Integration test setup: allow self-signed/local certs during local testing only.
// Do NOT use this in production environments.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
