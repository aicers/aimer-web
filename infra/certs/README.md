# Local Development TLS Certificates

This directory holds self-signed TLS certificates for local development.
The certificate files are gitignored and must be generated locally.

## Option 1: mkcert (recommended)

[mkcert](https://github.com/FiloSottile/mkcert) creates locally-trusted
certificates without browser warnings.

```sh
# Install mkcert (macOS)
brew install mkcert
mkcert -install

# Generate certificates in this directory
cd infra/certs
mkcert localhost 127.0.0.1 ::1
# Produces: localhost+2.pem and localhost+2-key.pem

# Rename to match nginx.dev.conf expectations
mv localhost+2.pem localhost.pem
mv localhost+2-key.pem localhost-key.pem
```

## Option 2: openssl

```sh
cd infra/certs
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout localhost-key.pem \
  -out localhost.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
```

Note: Browsers will show a security warning with self-signed openssl
certificates. Use mkcert to avoid this.

## Expected files

The Nginx dev config expects these files in this directory:

- `localhost.pem` -- TLS certificate
- `localhost-key.pem` -- TLS private key
