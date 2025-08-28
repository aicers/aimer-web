# aimer-web

Frontend for Aimer built with Next.js (App Router), React, Tailwind, Vitest, and
Biome.

## Quick Start

- Prereqs: Node 20+, npm 10+
- Install: `npm install`
- Configure env: create `.env.local` with:
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql` (client → built-in proxy)
  - `AIMER_GRAPHQL_ENDPOINT=https://<your-graphql-host>/graphql` (upstream)
    - Example for local dev: `https://127.0.0.1:8445/graphql`
  - Optionally `INSECURE_TLS=1` for local self‑signed upstream
- Run dev: `npm run dev` then open `http://localhost:8446`

## Deployment

### Test Deployments

> For local evaluation and testing. Not hardened for production.

#### Docker (single container, no Nginx)

Runs the production Next.js server inside a single container (no Nginx).

- Build (inject client endpoint at build time):

  ```bash
  docker build -t aimer-web:latest \
    --build-arg NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql .
  ```

- Run (set upstream endpoint at runtime):
  - macOS

    ```bash
    docker run --rm -p 8446:3000 \
      --name aimer-web \
      -e NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql \
      -e AIMER_GRAPHQL_ENDPOINT=https://host.docker.internal:8445/graphql \
      -e INSECURE_TLS=1 \
      aimer-web:latest
    ```

  - Linux (add host mapping)

    ```bash
    docker run --rm -p 8446:3000 \
      --name aimer-web \
      --add-host=host.docker.internal:host-gateway \
      -e NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql \
      -e AIMER_GRAPHQL_ENDPOINT=https://host.docker.internal:8445/graphql \
      -e INSECURE_TLS=1 \
      aimer-web:latest
    ```

- Access:
  - `http://localhost:8446`

- Verify:
  - `docker ps | grep aimer-web`
  - `docker logs -f aimer-web`

- Notes:
  - Use `/api/graphql` so the client calls the built‑in proxy. The server then calls
    `AIMER_GRAPHQL_ENDPOINT` and can optionally skip TLS verification with `INSECURE_TLS=1`
    (local/self‑signed only).
  - If you set `NEXT_PUBLIC_GRAPHQL_ENDPOINT` to an external URL instead, you must
    ensure proper CORS and a trusted certificate; otherwise the browser will block
    requests.

#### Docker Compose (with Nginx)

Use Nginx as a reverse proxy to the Next.js app (HTTP). For HTTPS, use the
dedicated HTTPS profile with your own certificate files.

- Configure env (`.env` in repo root):
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql` (client → built‑in proxy)
  - `AIMER_GRAPHQL_ENDPOINT=https://<your-graphql-host>/graphql` (upstream)
  - Optional (local/self‑signed upstream): `INSECURE_TLS=1`
  - Tip: copy from `.env.docker.example`

- Start:
  - `docker compose --profile http up --build -d`

- Access:
  - `http://localhost:8446`

- Verify:
  - `docker compose ps`
  - `docker compose logs -f nginx-http`

- Notes:
  - Nginx config: `docker/nginx/default.conf` (proxies to `web:3000`)
  - If your GraphQL server runs on the host, set
    `AIMER_GRAPHQL_ENDPOINT=https://host.docker.internal:<port>/graphql` in `.env`.
    On Linux, this works via `extra_hosts: ["host.docker.internal:host-gateway"]`
    (already configured).

#### Systemd + Nginx (example)

- Systemd unit example: `infrastructure/systemd/aimer-web.service.example`
  - Place app at `/opt/aimer-web`, run `sudo systemctl enable --now aimer-web`
- Nginx reverse proxy example: `infrastructure/nginx/aimer-web.conf.example`
  - Proxy to upstream `127.0.0.1:8446`

### Service Deployments

> Recommended for real services exposed to users; includes HTTPS.

#### Docker Compose (HTTPS with Nginx)

Terminate TLS at Nginx and proxy to the Next.js app.

- Prereqs:
  - Docker + Docker Compose v2
  - Valid TLS certificate/key (or self‑signed for testing)

- Configure env (`.env` in repo root):
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql`
  - `AIMER_GRAPHQL_ENDPOINT=https://<your-graphql-host>/graphql`
  - Optional (local/self‑signed upstream): `INSECURE_TLS=1`

- Place certificates:
  - `docker/nginx/certs/fullchain.pem`
  - `docker/nginx/certs/privkey.pem`

  Options to obtain/place certificates:

  - Use existing certificates (already issued on the host with your preferred tool)
    - Copy files into the repo mount path:

      ```bash
      mkdir -p docker/nginx/certs
      cp /path/to/fullchain.pem docker/nginx/certs/
      cp /path/to/privkey.pem   docker/nginx/certs/
      ```

    - Or mount original paths instead of copying (edit `docker-compose.https.yml`).

  - Generate a self‑signed certificate for testing (OpenSSL example)
    - OpenSSL (quick local cert for localhost):

      ```bash
      mkdir -p docker/nginx/certs
      openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
        -keyout docker/nginx/certs/privkey.pem \
        -out    docker/nginx/certs/fullchain.pem \
        -subj "/CN=localhost"
      ```

  - Set secure file permissions (optional but good practice):

    ```bash
    chmod 644 docker/nginx/certs/fullchain.pem
    chmod 600 docker/nginx/certs/privkey.pem
    ```

  - Notes:
    - `*.pem` files are ignored by Git (see `.gitignore`). Do not commit secrets.
    - For real domains, prefer valid public CAs (or the Let’s Encrypt setup below)
      over self‑signed certs.

- Start:
  - `docker compose --profile https up --build -d`

- Access:
  - `https://localhost:8446`

- Verify:
  - `docker compose ps`
  - `docker compose logs -f nginx-https`

- Notes:
  - Nginx config: `docker/nginx/default-ssl.conf` (HTTP→HTTPS redirect included)

## Scripts

- `npm run dev`: Run Next.js dev server
- `npm run build` / `npm start`: Production build and start
- `npm run lint`: Check code style with Biome
- `npm run format`: Auto‑format with Biome
- `npm run typecheck`: TypeScript check only (`tsc --noEmit`)
- `npm test`: Unit/component tests with Vitest (jsdom)
- `npm run test:int`: Integration test for GraphQL sign‑in (see below)

## CI

GitHub Actions workflow runs on push and PR:

- Biome check: style/lint
- Type check: `tsc --noEmit`
- Tests: Vitest (unit/component tests)

Workflow file: `.github/workflows/ci.yml`

## Integration Test (Real Server)

There is an opt‑in sign‑in integration test that calls your real GraphQL API:

- Test file: `__tests__/signin.int.test.ts`
- Dedicated config: `vitest.int.config.ts`
<!-- markdownlint-disable MD013 -->
- Run (macOS/Linux): `NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://<host>/graphql TEST_USERNAME=<u> TEST_PASSWORD=<p> npm run test:int`
<!-- markdownlint-enable MD013 -->

Notes:

- The integration test setup (`__tests__/setup.int.ts`) disables TLS verification
  only for this test run to make local/self‑signed endpoints workable. Do not use
  this in production.
- For browser sign‑in at `/signin`, use a valid certificate or a proxy route; browsers
  cannot bypass TLS verification programmatically.

## Tech Highlights

- Next.js App Router (server components by default)
- Tailwind CSS v4, minimal shadcn‑style UI components (Button/Input)
- React Hook Form + Zod validation on the sign‑in form
- GraphQL client via `graphql-request` (`NEXT_PUBLIC_GRAPHQL_ENDPOINT`)
