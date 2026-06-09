-- RFC 0004 (#507) — group data DB extensions.
--
-- Mirror of migrations/customer/0000_extensions.sql. pgcrypto is the
-- minimal extension dependency carried into every subject data DB so the
-- group result schema lands on the same baseline as a customer DB.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
