# aimer-web

aimer-web is a web application for in-depth AI analysis of threat events. Upstream detection systems surface suspicious activity using unsupervised and semi-supervised learning; aimer-web takes those detected events and produces deep, AI-driven analysis — enrichment, correlation, and explanation — so analysts can understand and act on real threats.

It is the analysis application itself, not a thin frontend for any single backend.

## Architecture

aimer-web orchestrates several services to deliver its analysis:

- **aimer** — the AI-analysis API server that aimer-web consumes. It is one backend dependency, not the product.
- **aice-web-next** — the upstream source of detected threats and related data.

aimer-web ties these together behind a single web experience.

## Documentation

The user manual lives in [`docs/`](docs/) and is built with [MkDocs](https://www.mkdocs.org/) (see [`mkdocs.yml`](mkdocs.yml)). Start with [`docs/en/index.md`](docs/en/index.md).

## Tech stack

- [Next.js](https://nextjs.org/) (App Router) with TypeScript
- [pnpm](https://pnpm.io/) — the only supported package manager
- [Biome](https://biomejs.dev/) for linting and formatting
- [Vitest](https://vitest.dev/) and [Playwright](https://playwright.dev/) for testing

## Development

This project uses **pnpm exclusively** — do not use npm, yarn, or bun.

```sh
pnpm install   # install dependencies
pnpm dev       # start the dev server
```

Before committing or opening a PR, make sure the CI checks pass locally:

```sh
pnpm check      # Biome lint/format
pnpm typecheck  # type checks
pnpm test       # unit and DB tests
```

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE).
