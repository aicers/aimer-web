# aimer-web

Frontend for Aimer built with Next.js (App Router), React, Tailwind, Vitest, and
Biome.

## Quick Start

- Prereqs: Node 20+, npm 10+
- Install: `npm install`
- Configure env: create `.env.local` with:
  - `NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://<your-graph-ql-host>/graphql`
- Run dev: `npm run dev` then open `http://localhost:8446`
- Try sign in: go to `/signin?mode=user` or `/signin?mode=admin`

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
- Run (macOS/Linux):

  ```shell
  NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://<host>/graphql TEST_USERNAME=<u>\n
  TEST_PASSWORD=<p> npm run test:int`
  ```

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
