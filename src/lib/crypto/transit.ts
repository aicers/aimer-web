import "server-only";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransitConfig {
  addr: string;
  token: string;
}

export interface DataKey {
  /** Raw 256-bit AES key. Caller must zero after use. */
  plaintext: Buffer;
  /** Base64-encoded Transit-wrapped ciphertext of the key. */
  wrappedDek: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getTransitConfig(): TransitConfig {
  const addr = process.env.BAO_ADDR;
  const token = process.env.BAO_TOKEN;
  if (!addr) throw new Error("BAO_ADDR environment variable is required");
  if (!token) throw new Error("BAO_TOKEN environment variable is required");
  return { addr, token };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function transitRequest(
  config: TransitConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${config.addr}/v1/transit/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Vault-Token": config.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transit ${path} failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { data?: Record<string, unknown> };
  if (!json.data) {
    throw new Error(`Transit ${path}: missing data in response`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new data encryption key via Transit.
 * Returns both the plaintext key (for local AES-GCM) and the
 * Transit-wrapped form (for storage alongside ciphertext).
 */
export async function generateDataKey(
  config: TransitConfig,
  keyName: string,
): Promise<DataKey> {
  const data = await transitRequest(config, `datakey/plaintext/${keyName}`, {});
  const plaintextB64 = data.plaintext as string;
  const wrappedDek = data.ciphertext as string;
  if (typeof plaintextB64 !== "string" || typeof wrappedDek !== "string") {
    throw new Error("Transit datakey: unexpected response shape");
  }
  return {
    plaintext: Buffer.from(plaintextB64, "base64"),
    wrappedDek,
  };
}

/**
 * Decrypt (unwrap) a Transit-wrapped DEK back to plaintext.
 */
export async function decryptDataKey(
  config: TransitConfig,
  keyName: string,
  wrappedDek: string,
): Promise<Buffer> {
  const data = await transitRequest(config, `decrypt/${keyName}`, {
    ciphertext: wrappedDek,
  });
  const plaintextB64 = data.plaintext as string;
  if (typeof plaintextB64 !== "string") {
    throw new Error("Transit decrypt: unexpected response shape");
  }
  return Buffer.from(plaintextB64, "base64");
}

/**
 * Re-wrap a DEK under the latest version of the named key.
 * Used for key rotation without re-encrypting data.
 */
export async function rewrapDataKey(
  config: TransitConfig,
  keyName: string,
  wrappedDek: string,
): Promise<string> {
  const data = await transitRequest(config, `rewrap/${keyName}`, {
    ciphertext: wrappedDek,
  });
  const newWrapped = data.ciphertext as string;
  if (typeof newWrapped !== "string") {
    throw new Error("Transit rewrap: unexpected response shape");
  }
  return newWrapped;
}
