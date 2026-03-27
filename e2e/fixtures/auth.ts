import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BrowserContext } from "@playwright/test";

// jose is ESM-only — use dynamic import() to avoid CJS/ESM conflicts
// when Playwright transpiles test files.
async function loadJose() {
  return import("jose");
}

// ---------------------------------------------------------------------------
// Key pair (cached, auto-generated if missing)
// ---------------------------------------------------------------------------

interface KeyPair {
  privateKey: CryptoKey;
  kid: string;
}

let cached: KeyPair | null = null;

function keysDir(): string {
  const dataDir = process.env.DATA_DIR ?? "./data";
  // Use process.cwd() instead of import.meta.dirname because Playwright's
  // esbuild transform outputs CJS — import.meta is not available in CJS and
  // triggers "exports is not defined" under Node 24's module detection.
  const resolvedDataDir = isAbsolute(dataDir)
    ? dataDir
    : join(process.cwd(), dataDir);
  return join(resolvedDataDir, "keys");
}

/**
 * Load or generate the ES256 key pair used for JWT signing.
 * Mirrors the auto-generation logic in src/lib/auth/jwt-keys.ts so that
 * the fixture works even when keys have not been pre-provisioned (e.g. CI).
 * The dev server will later load the same files.
 */
async function getKeyPair(): Promise<KeyPair> {
  if (cached) return cached;

  const dir = keysDir();
  const privatePath = join(dir, "ec-private.pem");
  const publicPath = join(dir, "ec-public.pem");

  const jose = await loadJose();

  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    mkdirSync(dir, { recursive: true });
    const kp = await jose.generateKeyPair("ES256", { extractable: true });
    writeFileSync(privatePath, await jose.exportPKCS8(kp.privateKey), "utf-8");
    writeFileSync(publicPath, await jose.exportSPKI(kp.publicKey), "utf-8");
  }

  const privatePem = readFileSync(privatePath, "utf-8");
  const publicPem = readFileSync(publicPath, "utf-8");

  const privateKey = (await jose.importPKCS8(privatePem, "ES256")) as CryptoKey;
  const publicKey = (await jose.importSPKI(publicPem, "ES256")) as CryptoKey;
  const jwk = await jose.exportJWK(publicKey);
  const kid = await jose.calculateJwkThumbprint(jwk);

  cached = { privateKey, kid };
  return cached;
}

// ---------------------------------------------------------------------------
// CSRF generation (mirrors src/lib/auth/csrf.ts)
// ---------------------------------------------------------------------------

function generateCsrf(ctx: string, sid: string, iat: number): string {
  const secret = process.env.CSRF_SECRET;
  if (!secret) throw new Error("CSRF_SECRET must be set for E2E fixtures");
  return createHmac("sha256", secret)
    .update(`${ctx}:${sid}:${iat}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Cookie injection
// ---------------------------------------------------------------------------

export type AuthContext = "general" | "admin";

export async function injectAuthCookies(
  context: BrowserContext,
  params: { accountId: string; sessionId: string },
  authContext: AuthContext = "general",
): Promise<void> {
  const jose = await loadJose();
  const { privateKey, kid } = await getKeyPair();
  const iss = authContext === "general" ? "aimer-web" : "aimer-web-admin";
  const expMinutes = Number(process.env.JWT_EXPIRATION_MINUTES) || 15;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expMinutes * 60;

  const token = await new jose.SignJWT({
    sid: params.sessionId,
    ctx: authContext,
    tv: 0,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(params.accountId)
    .setIssuer(iss)
    .setAudience(iss)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);

  const csrf = generateCsrf(authContext, params.sessionId, iat);

  const names =
    authContext === "general"
      ? { at: "at", csrf: "csrf", tokenExp: "token_exp" }
      : { at: "at_admin", csrf: "csrf_admin", tokenExp: "token_exp_admin" };

  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const domain = new URL(baseUrl).hostname;

  await context.addCookies([
    { name: names.at, value: token, domain, path: "/" },
    { name: names.csrf, value: csrf, domain, path: "/" },
    { name: names.tokenExp, value: String(exp), domain, path: "/" },
  ]);
}
