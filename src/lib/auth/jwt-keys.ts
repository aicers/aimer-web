import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
} from "jose";

export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

let cached: KeyPair | null = null;

function keysDir(): string {
  const dataDir = process.env.DATA_DIR ?? "./data";
  return join(dataDir, "keys");
}

const PRIVATE_KEY_FILE = "ec-private.pem";
const PUBLIC_KEY_FILE = "ec-public.pem";

async function computeKid(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportJWK(publicKey);
  return calculateJwkThumbprint(jwk);
}

async function generateAndSaveKeyPair(): Promise<KeyPair> {
  const dir = keysDir();
  mkdirSync(dir, { recursive: true });

  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);

  writeFileSync(join(dir, PRIVATE_KEY_FILE), privatePem, "utf-8");
  writeFileSync(join(dir, PUBLIC_KEY_FILE), publicPem, "utf-8");

  const kid = await computeKid(publicKey as CryptoKey);
  return {
    privateKey: privateKey as CryptoKey,
    publicKey: publicKey as CryptoKey,
    kid,
  };
}

async function loadKeyPairFromDisk(): Promise<KeyPair> {
  const dir = keysDir();
  const privatePath = join(dir, PRIVATE_KEY_FILE);
  const publicPath = join(dir, PUBLIC_KEY_FILE);

  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `JWT key files not found at ${dir}. In production, keys must be pre-generated.`,
      );
    }
    return generateAndSaveKeyPair();
  }

  const privatePem = readFileSync(privatePath, "utf-8");
  const publicPem = readFileSync(publicPath, "utf-8");

  const privateKey = (await importPKCS8(privatePem, "ES256")) as CryptoKey;
  const publicKey = (await importSPKI(publicPem, "ES256")) as CryptoKey;

  const kid = await computeKid(publicKey);
  return { privateKey, publicKey, kid };
}

export async function getKeyPair(): Promise<KeyPair> {
  if (!cached) {
    cached = await loadKeyPairFromDisk();
  }
  return cached;
}

/** Clear the cached key pair (useful for tests). */
export function clearKeyPairCache(): void {
  cached = null;
}
