-- L1 (#387) — app-wide language preference.
--
-- `accounts.locale` is now written by the self-service preferences API
-- (`PATCH /api/account/preferences`) and the sign-in locale sync, and it
-- feeds locale resolution (saved preference → Accept-Language → default).
-- Constrain it to the supported app locales so a bad write cannot poison
-- resolution. The column stays nullable: NULL means "no saved preference".
--
-- `accounts.timezone` is deliberately left unconstrained at the DB level.
-- The IANA zone set is large and runtime-dependent, so it is validated in
-- the application layer (`isValidTimeZone`) instead of a CHECK constraint.

ALTER TABLE accounts
  ADD CONSTRAINT accounts_locale_check
  CHECK (locale IS NULL OR locale IN ('en', 'ko'));
