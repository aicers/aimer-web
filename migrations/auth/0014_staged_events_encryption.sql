-- Add wrapped DEK column for OpenBao Transit envelope encryption.
-- The payload column now stores AES-256-GCM ciphertext instead of plaintext.

-- Remove any existing plaintext rows (dev-only; production has no staging data yet)
DELETE FROM staged_event_customers;
DELETE FROM staged_event_payloads;

ALTER TABLE staged_event_payloads
  ADD COLUMN wrapped_dek TEXT NOT NULL;
