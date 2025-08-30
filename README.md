# aimer-web

Next.js‑based frontend for Aimer. Provides two apps: Admin and User.

## Prerequisites

- Node 22: Use Node.js 22.x. Do not use Node 24 — Next.js 15.5.0 is more stable
  and better supported on Node 22.
  - nvm example: `nvm install 22 && nvm use 22`
  - macOS (Homebrew):
    - `brew update && brew install node@22`
    - Link it: `brew link --overwrite --force node@22`
    - Verify: `node -v` should print v22.x.y
- npm: Use the npm bundled with Node 22 (or npm 10+).
- Docker: Install Docker (Docker Desktop or Docker Engine)

## Port Configuration

- If your Aimer backend uses a different port than the default 8445, update the
  configuration accordingly.
- By default, aimer-web runs on port 8446. You can change this port if necessary.

## Networking & GraphQL Proxy

### Architecture

This project can run with an optional edge proxy (Nginx) in front of the app,
resulting in a two-layer reverse proxy model. If Nginx is not used, only the
in‑app proxy (Next.js API route) is active.

- Edge proxy (if used): Nginx
  - HTTPS (production):
    - Host → container: `8446 → 443` (TLS terminated at Nginx)
    - Nginx: `listen 443 ssl;` → `proxy_pass http://web:3000`
    - Use the `https` profile; production must serve HTTPS.
  - HTTP (development):
    - Host → container: `8446 → 8080`
    - Nginx: `listen 8080;` → `proxy_pass http://web:3000`
    - You may also skip Nginx entirely and access the app directly.
  - Purpose: stable external port, HTTPS termination for production, keep the app
    container private.
  - Note: when Nginx is used, the Next.js app (service `web`) listens on
    internal port `3000` and Nginx proxies to `web:3000`. When accessing Next.js
    directly without Nginx in local development, it listens on `8446`
    (`npm run dev -p 8446`).
- In-app proxy: Next.js API route
  - Route: `/api/graphql` at `src/app/api/graphql/route.ts`.
  - Role: receive browser requests and forward them server-side to the real
    GraphQL upstream (`AIMER_GRAPHQL_ENDPOINT`).
  - Auth: reads the HttpOnly cookie `aimer_token` and attaches
    `Authorization: Bearer <token>` to the upstream call.

Flow overview

- Browser → (optional Nginx) → Next.js → `/api/graphql` → Aimer GraphQL upstream
- Without Nginx, the browser talks directly to the Next.js app; the `/api/graphql`
  behavior is the same.

Port behavior by scenario

- Local development (no Nginx): `npm run dev -p 8446` → Next.js listens on 8446 directly.
- Docker single container (no Nginx): Next.js listens on 3000 in the container;
  host maps `8446:3000`.
- Docker Compose with Nginx:
  - HTTP profile: host 8446 → Nginx 8080 → Next.js `web:3000`.
  - HTTPS profile: host 8446 → Nginx 443 (TLS) → Next.js `web:3000`.

Why this matters

- CORS simplicity: the browser calls same-origin `/api/graphql`, so CORS doesn’t
  trigger.
- Security: token stays in an HttpOnly cookie; only the server attaches it to upstream
  requests.

### GraphQL Endpoint Policy

- Required (current design): set `NEXT_PUBLIC_GRAPHQL_ENDPOINT` to `/api/graphql`
  only.
  - Rationale: ensures the browser always hits the in-app proxy so the server can
    read the HttpOnly cookie and add `Authorization` securely.
- What if you set an absolute URL (e.g., `https://api.example.com/graphql`)?
  - Behavior: the browser calls the upstream directly, bypassing the in-app proxy.
    In that case `AIMER_GRAPHQL_ENDPOINT` is not used.
  - To make this work correctly, additional changes are required on both sides:
    - On Aimer (upstream):
      - CORS: allow your app’s origin explicitly, and if cookies are used, set
        `Access-Control-Allow-Credentials: true` (no wildcard origin).
      - Cookies (if using cookie auth): issue cookies with `Domain=.example.com`,
        `SameSite=None; Secure` so cross-site cookies can be sent.
    - On aimer-web (this app):
      - Client fetch: use `credentials: 'include'` for cookie-based auth; or
      - Switch to a JS-managed bearer token (less secure than HttpOnly), and ensure
        the API allows the `Authorization` header.
  - Status: this absolute-URL mode is not enabled by default. We may consider it
    later; for now, use `/api/graphql`.

## Development

- Install: `npm install`
- Configure env: create `.env.local` with:
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql` (client → built-in proxy)
  - `AIMER_GRAPHQL_ENDPOINT=https://<your-graphql-host>/graphql` (upstream)
    - Example for local dev: `https://127.0.0.1:8445/graphql`
  - Optionally `INSECURE_TLS=1` for local self‑signed upstream
  - Tip: copy from `.env.local.example`
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
    - If your GraphQL server runs on the host, set
      `AIMER_GRAPHQL_ENDPOINT=https://host.docker.internal:8445/graphql` in `.env`.
      On Linux, this works via `extra_hosts: ["host.docker.internal:host-gateway"]`
      (already configured).
  - Optional (local/self‑signed upstream): `INSECURE_TLS=1`
  - Tip: copy from `.env.example`

- Build and start:
  - `docker compose --profile http up --build -d`

- Access:
  - `http://localhost:8446`

- Verify:
  - `docker compose ps`
  - `docker compose logs -f nginx-http`

- Notes:
  - Nginx config: `docker/nginx/default.conf` (proxies to `web:3000`)

### Service Deployments

> Recommended for real services exposed to users; includes HTTPS.

#### Docker Compose (HTTPS with Nginx)

Terminate TLS at Nginx and proxy to the Next.js app.

- Configure env (`.env` in repo root):
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=/api/graphql`
  - `AIMER_GRAPHQL_ENDPOINT=https://<your-graphql-host>/graphql`
    - If your GraphQL server runs on the host, set
      `AIMER_GRAPHQL_ENDPOINT=https://host.docker.internal:8445/graphql` in `.env`.
      On Linux, this works via `extra_hosts: ["host.docker.internal:host-gateway"]`
      (already configured).
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
    - For real domains, prefer valid public CAs over self‑signed certs.

- Build and start:
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

- Biome check: style/lint/format (fails on mismatch)
- Type check: `tsc --noEmit` with strict options
- Tests: Vitest (unit/component tests)

Workflow file: `.github/workflows/ci.yml`

## Quality Checks (AI‑Assisted Coding)

Because we will generate code frequently via AI agents, this project enforces
strong, automated checks to keep quality high and regressions low:

- Biome: one tool for lint + format
  - Local: `npm run format:check` (or `npm run lint`), auto‑fix: `npm run lint:fix`
    / `npm run format`
  - CI: fails if formatting or lint rules are violated
- TypeScript: strict + extra safety flags
  - `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
  - Local: `npm run typecheck` (runs `tsc --noEmit`)
- Tests: Vitest + React Testing Library
  - Local: `npm test` (single‑thread pool configured for stability)
  - Integration (opt‑in): `npm run test:int` (calls real GraphQL if env vars present)
- Markdown: `markdownlint` checks docs consistency
- CI gating: tests run only after checks pass (`needs: check`)
- Build validation: CI builds the Next.js app and Docker image, and verifies Nginx
  configs with `nginx -t`

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
