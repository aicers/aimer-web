# Changelog

This file documents recent notable changes to this project. The format of this
file is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Internationalization (i18n) support with `next-intl` for English and Korean
- Locale-based routing using `/[locale]/` directory structure
- Language switcher component with dynamic URL switching
- Message files for English (`messages/en.json`) and Korean (`messages/ko.json`)
- User and Admin app routes (`/user`, `/admin`) and a sign‑in screen/flow (`/signin`).
- Auth via HttpOnly cookie with cookie management routes (`/api/auth/set-cookie`,
  `/api/auth/signout`); sign-in sets the cookie via the API.
- Reusable `friendlyError` util for concise user-facing error messages
- Next.js GraphQL proxy continues reading token from cookies and forwarding to upstream
- Split Nginx into profiles (`nginx-http`, `nginx-https`); bind host 8446 and proxy
  to `web:3000`

[Unreleased]: https://github.com/aicers/aimer-web/tree/HEAD
