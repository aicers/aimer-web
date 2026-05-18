import "server-only";

import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { importPKCS8, SignJWT } from "jose";
import { Agent } from "undici";

export const AIMER_AUDIENCE = "aimer";

type JwtAlgorithm = "RS256" | "RS384" | "RS512" | "ES256" | "ES384";

interface MtlsState {
  agent: Agent;
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  algorithm: JwtAlgorithm;
  certNotAfter: Date;
  certFingerprint: string;
}

interface LeasedState extends MtlsState {
  refCount: number;
  retired: boolean;
}

let state: LeasedState | null = null;

// Single mutex queue for every write to `state`. ALL paths that assign `state`
// — first-use init AND reload() — run inside this queue. The "single writer"
// property guarantees no two `buildState()` runs install `state` concurrently,
// so a late init can never overwrite a fresher reload result and vice versa.
let stateLifecycle: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = stateLifecycle.then(fn, fn);
  // Swallow this slot's rejection on the chain so a single failure does not
  // poison subsequent enqueues; callers still see the rejection on `next`.
  stateLifecycle = next.catch(() => {});
  return next;
}

let reloadPending: Promise<Agent> | null = null;
let reloadDirty = false;

export function detectAlgorithm(certPem: string): JwtAlgorithm {
  const x509 = new X509Certificate(certPem);
  const { asymmetricKeyType, asymmetricKeyDetails } = x509.publicKey;

  if (asymmetricKeyType === "rsa") {
    const bits = asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits >= 4096) return "RS512";
    if (bits >= 3072) return "RS384";
    return "RS256";
  }
  if (asymmetricKeyType === "ec") {
    const curve = asymmetricKeyDetails?.namedCurve;
    if (curve === "prime256v1") return "ES256";
    if (curve === "secp384r1") return "ES384";
    throw new Error(`Unsupported EC curve: ${curve}`);
  }
  throw new Error(`Unsupported key type: ${asymmetricKeyType}`);
}

function readEnvPath(envVar: string): string {
  const filePath = process.env[envVar];
  if (!filePath) {
    throw new Error(`Missing environment variable: ${envVar}`);
  }
  return readFileSync(filePath, "utf8");
}

/**
 * Normalize a private-key PEM to PKCS#8. `jose.importPKCS8` only accepts
 * PKCS#8 (`-----BEGIN PRIVATE KEY-----`) and silently rejects PKCS#1 RSA
 * (`-----BEGIN RSA PRIVATE KEY-----`) or SEC1 EC
 * (`-----BEGIN EC PRIVATE KEY-----`). `node:crypto.createPrivateKey` accepts
 * all three, so route through it and re-export as PKCS#8.
 */
function normalizeToPkcs8(keyPem: string): string {
  const key = createPrivateKey(keyPem);
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/**
 * Compare a private key against a certificate's public key by exporting both
 * to DER/SPKI and checking byte-equality. Precise and side-effect-free, unlike
 * a sign-then-verify probe.
 *
 * Distinguishes "algorithm mismatch" (key is RSA but cert is EC, or vice
 * versa) from "pair mismatch" (same algorithm, different key material), so
 * the caller can act on each error class independently.
 */
function assertKeyMatchesCert(keyPem: string, certPem: string): void {
  const privKey = createPrivateKey(keyPem);
  const cert = new X509Certificate(certPem);
  const certPubKey = cert.publicKey;

  if (privKey.asymmetricKeyType !== certPubKey.asymmetricKeyType) {
    throw new Error(
      `mTLS algorithm mismatch: private key is ${privKey.asymmetricKeyType}, certificate is ${certPubKey.asymmetricKeyType}`,
    );
  }

  const fromKey = createPublicKey(privKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const fromCert = certPubKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  if (fromKey !== fromCert) {
    throw new Error(
      "mTLS private key does not match the certificate's public key",
    );
  }
}

async function buildState(): Promise<MtlsState> {
  const cert = readEnvPath("MTLS_CERT_PATH");
  const key = readEnvPath("MTLS_KEY_PATH");
  const ca = readEnvPath("MTLS_CA_PATH");

  const algorithm = detectAlgorithm(cert);
  assertKeyMatchesCert(key, cert);
  const pkcs8 = normalizeToPkcs8(key);
  const privateKey = await importPKCS8(pkcs8, algorithm);

  const x509 = new X509Certificate(cert);
  const certNotAfter = new Date(x509.validTo);
  const certFingerprint = x509.fingerprint256;

  const agent = new Agent({
    connect: { cert, key, ca },
  });

  const built: MtlsState = {
    agent,
    privateKey,
    algorithm,
    certNotAfter,
    certFingerprint,
  };

  // Publish the cert info to the global slot BEFORE checking/installing the
  // timer so the (single, global) interval callback always reads the freshest
  // value regardless of which module instance built it. The timer is installed
  // once and lives in a `Symbol.for` global slot; after HMR re-evaluates this
  // module, the new instance's `buildState()` updates the same global slot
  // that the surviving timer reads, so expiry warnings track the currently
  // loaded cert instead of a stale closure over the old module's state.
  publishCurrentCert(built);
  checkCertExpiry(built);
  installExpiryTimer();

  return built;
}

function acquire(s: LeasedState): void {
  s.refCount++;
}

function releaseState(s: LeasedState): void {
  s.refCount--;
  if (s.retired && s.refCount === 0) {
    // Last in-flight request finished; drain the retired agent. Catch the
    // promise so a close() failure cannot become an unhandled rejection
    // (which under --unhandled-rejections=strict would crash the process).
    s.agent.close().catch((err) => {
      console.error("[mtls] failed to close retired agent", err);
    });
  }
}

/**
 * Read `state` and increment its refcount as one operation, with no
 * microtask boundary in between when state is already installed.
 *
 * The earlier shape `await ensureState(); acquire(current);` had an
 * unleased window: if a concurrent `reload()` had already finished
 * `buildState()` and its continuation was queued behind the awaiter's,
 * the reload could install the new state, retire the old one, and call
 * `releaseState` — driving the old refcount to zero and starting
 * `agent.close()` — before `acquire()` ran. The caller then dispatched
 * with a closing agent. Acquiring synchronously on the fast path (and
 * before returning from the queued first-init job on the slow path)
 * closes that window: the structural refcount is bumped to ≥ 2 before
 * any other microtask can retire the state.
 */
function acquireState(): LeasedState | Promise<LeasedState> {
  if (state) {
    acquire(state);
    return state;
  }
  return runExclusive(async () => {
    if (state) {
      acquire(state);
      return state;
    }
    const built = await buildState();
    state = { ...built, refCount: 1, retired: false };
    acquire(state);
    return state;
  });
}

export interface MtlsRequestAuth {
  agent: Agent;
  token: string;
  release(): void;
}

interface MtlsRequestAuthClaims {
  sub: string;
  aice_id: string;
}

/**
 * Snapshot helper that reads `state` once, increments its refcount, and
 * returns the agent + a freshly-signed JWT derived from that single snapshot.
 *
 * The JWT carries `aud="aimer"`, `sub`, `aice_id`, `jti`, and `exp = iat + 300`.
 * No `customer_ids` claim: aimer is stateless, so customer authorization
 * lives entirely on the BFF route layer.
 *
 * The caller MUST invoke `release()` (typically in a `finally`) so the
 * refcount is decremented when the dispatch completes. `release()` is
 * idempotent: a duplicate call is a no-op rather than pushing the refcount
 * negative — a negative refcount would break the close-deferral timing for
 * the next retired state.
 *
 * Pairing the agent and the JWT against the same `state` reference closes
 * (a) the JWT/cert pairing race during rotation and (b) the
 * "snapshot's agent gets closed mid-request" race.
 */
export async function createMtlsRequestAuth(
  claims: MtlsRequestAuthClaims,
): Promise<MtlsRequestAuth> {
  const current = await acquireState();
  try {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 300;
    const token = await new SignJWT({ aice_id: claims.aice_id })
      .setProtectedHeader({ alg: current.algorithm })
      .setSubject(claims.sub)
      .setAudience(AIMER_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(current.privateKey);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseState(current);
    };
    return { agent: current.agent, token, release };
  } catch (err) {
    releaseState(current);
    throw err;
  }
}

export function reload(): Promise<Agent> {
  if (reloadPending) {
    // Coalesce overlapping reloads. The dirty flag ensures that a SIGHUP
    // arriving mid-reload re-runs buildState() once after the current run,
    // so a fast double rotation always converges on the latest disk state.
    reloadDirty = true;
    return reloadPending;
  }
  reloadPending = runExclusive(async () => {
    try {
      let next: LeasedState;
      do {
        reloadDirty = false;
        const previous = state;
        const built = await buildState();
        next = { ...built, refCount: 1, retired: false };
        state = next;
        if (previous) {
          // Mark retired and drop the structural reference. In-flight
          // requests still hold leases; the last release() will close()
          // the old agent.
          previous.retired = true;
          releaseState(previous);
        }
      } while (reloadDirty);
      return next.agent;
    } finally {
      reloadPending = null;
    }
  });
  return reloadPending;
}

// ── Certificate expiry monitoring ───────────────────────────────────────────

const EXPIRY_TIMER_SLOT = Symbol.for("aimer.mtls.expiryTimer");
const EXPIRY_WARN_SLOT = Symbol.for("aimer.mtls.expiryWarnedAt");
const EXPIRY_CURRENT_SLOT = Symbol.for("aimer.mtls.expiryCurrent");

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type ExpirySnapshot = Pick<MtlsState, "certNotAfter" | "certFingerprint">;

type GlobalWithExpirySlots = typeof globalThis & {
  [EXPIRY_TIMER_SLOT]?: NodeJS.Timeout;
  [EXPIRY_WARN_SLOT]?: { fingerprint: string; at: number };
  [EXPIRY_CURRENT_SLOT]?: ExpirySnapshot;
};

function publishCurrentCert(s: ExpirySnapshot): void {
  (globalThis as GlobalWithExpirySlots)[EXPIRY_CURRENT_SLOT] = {
    certNotAfter: s.certNotAfter,
    certFingerprint: s.certFingerprint,
  };
}

function checkCertExpiry(s: ExpirySnapshot): void {
  const now = Date.now();
  const msUntilExpiry = s.certNotAfter.getTime() - now;
  if (msUntilExpiry > THREE_DAYS_MS) return;

  const g = globalThis as GlobalWithExpirySlots;
  const last = g[EXPIRY_WARN_SLOT];
  if (
    last &&
    last.fingerprint === s.certFingerprint &&
    now - last.at < ONE_DAY_MS
  ) {
    return;
  }
  g[EXPIRY_WARN_SLOT] = { fingerprint: s.certFingerprint, at: now };

  if (msUntilExpiry <= 0) {
    console.error(
      `[mtls] client certificate has EXPIRED at ${s.certNotAfter.toISOString()} (fingerprint ${s.certFingerprint})`,
    );
  } else {
    const days = Math.floor(msUntilExpiry / ONE_DAY_MS);
    console.warn(
      `[mtls] client certificate expires in ${days} day(s) at ${s.certNotAfter.toISOString()} (fingerprint ${s.certFingerprint})`,
    );
  }
}

function installExpiryTimer(): void {
  const g = globalThis as GlobalWithExpirySlots;
  if (g[EXPIRY_TIMER_SLOT]) return;
  const timer = setInterval(() => {
    // Read the current cert from the global slot rather than the module-local
    // `state` variable. Under HMR, multiple module instances can exist; the
    // timer survives in the first instance that installed it, but the global
    // slot is updated by whichever module instance most recently ran
    // buildState(). Closing over `state` here would warn on a stale cert.
    const current = (globalThis as GlobalWithExpirySlots)[EXPIRY_CURRENT_SLOT];
    if (current) checkCertExpiry(current);
  }, SIX_HOURS_MS);
  timer.unref();
  g[EXPIRY_TIMER_SLOT] = timer;
}
