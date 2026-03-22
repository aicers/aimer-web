#!/bin/sh
# Wait for OpenBao to become ready, then enable the Transit secret engine.
set -e

export BAO_ADDR="http://127.0.0.1:8200"
export BAO_TOKEN="${BAO_DEV_ROOT_TOKEN_ID:-dev-root-token}"

echo "Waiting for OpenBao to start..."
until bao status >/dev/null 2>&1; do
    sleep 1
done

echo "Enabling Transit secret engine..."
bao secrets enable transit || echo "Transit engine already enabled"

echo "Transit secret engine is ready."
