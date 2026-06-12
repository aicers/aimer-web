#!/bin/sh
# Auto-initialize, unseal, and configure Transit on OpenBao startup.
#
# First boot:  init with single Shamir key, save keys to /bao/init/keys.json
# Every boot:  unseal using saved key, enable Transit engine
set -e

export BAO_ADDR="http://127.0.0.1:8200"
KEYS_FILE="/bao/init/keys.json"

echo "Waiting for OpenBao to start..."
# bao status exits 0 only when initialized+unsealed.  On a fresh server it
# exits non-zero (uninitialized/sealed) but still prints output once the
# HTTP API is reachable.  Wait for that output to appear.
while ! bao status 2>&1 | grep -q "Seal Type"; do
  sleep 1
done

# Initialize if not yet done
if bao status 2>/dev/null | grep -q "Initialized.*false"; then
  echo "Initializing OpenBao (single Shamir key)..."
  mkdir -p /bao/init
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$KEYS_FILE"
  echo "Keys saved to $KEYS_FILE"
fi

if [ ! -f "$KEYS_FILE" ]; then
  echo "ERROR: $KEYS_FILE not found. Cannot unseal." >&2
  exit 1
fi

# Parse unseal key and root token from JSON (works with BusyBox tools).
FLAT=$(tr -d '\n ' < "$KEYS_FILE")
UNSEAL_KEY=$(echo "$FLAT" | grep -o '"unseal_keys_b64":\["[^"]*"' | grep -o '\["[^"]*"' | tr -d '["')
ROOT_TOKEN=$(echo "$FLAT" | grep -o '"root_token":"[^"]*"' | cut -d: -f2 | tr -d '"')

if [ -z "$UNSEAL_KEY" ] || [ -z "$ROOT_TOKEN" ]; then
  echo "ERROR: Failed to parse keys from $KEYS_FILE" >&2
  exit 1
fi

# Unseal if sealed
if bao status 2>/dev/null | grep -q "Sealed.*true"; then
  echo "Unsealing OpenBao..."
  bao operator unseal "$UNSEAL_KEY"
fi

export BAO_TOKEN="$ROOT_TOKEN"

echo "Enabling Transit secret engine..."
bao secrets enable transit 2>/dev/null || echo "Transit engine already enabled"

echo "Creating staging-events key..."
bao write -f transit/keys/staging-events 2>/dev/null || echo "staging-events key already exists"

echo "Creating feed-secrets key (TI feed self-fetch Auth-Key, #568)..."
bao write -f transit/keys/feed-secrets 2>/dev/null || echo "feed-secrets key already exists"

echo "OpenBao is ready. Root token: $ROOT_TOKEN"
