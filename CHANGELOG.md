# Changelog

This file documents recent notable changes to this project. The format of this
file is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- User and Admin app routes (`/[locale]/user`, `/[locale]/admin`) and a sign‑in
  screen/flow (`/[locale]/signin`).
- Auth via HttpOnly cookie with cookie management routes (`/api/auth/set-cookie`,
  `/api/auth/signout`); sign-in sets the cookie via the API.
- Reusable `friendlyError` util for concise user-facing error messages
- Next.js GraphQL proxy continues reading token from cookies and forwarding to upstream
- Split Nginx into profiles (`nginx-http`, `nginx-https`); bind host 8446 and proxy
  to `web:3000`

[Unreleased]: https://github.com/aicers/aimer-web/tree/HEAD
