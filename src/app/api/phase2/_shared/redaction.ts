import type { PoolClient } from "pg";
import {
  EMPTY_OWNED_DOMAIN_SET,
  ENGINE_VERSION,
  type OwnedDomainSet,
  type RangeSet,
  RedactionInjectivityError,
  readMapWithLock,
  redact,
  writeMap,
} from "@/lib/redaction";

export interface RedactionContext {
  customerId: string;
  aiceId: string;
  eventKey: string;
  ranges: RangeSet;
  /**
   * Customer-owned domain suffixes (RFC 0001 Amendment A.2). Optional:
   * defaults to an empty set (redact no domains) so any path not yet
   * wired to load owned domains keeps the prior behaviour.
   */
  ownedDomains?: OwnedDomainSet;
  client: PoolClient;
}

/**
 * Redact one Phase 2 event payload and UPSERT the matching
 * `event_redaction_map` row when needed (engine merged new entities
 * OR the row did not exist yet — second clause keeps the "every
 * ingested event has a map row" invariant from RFC 0001).
 *
 * Returns the redacted payload plus the
 * `engine:<semver>|ranges:<sha256-short>` policy version to stamp on
 * the referent row.
 *
 * Shared by the regular ingest path (`ingest.ts`) and the
 * window-replace path (`window-replace.ts`); both must emit the same
 * `(redacted JSONB, redaction_policy_version)` storage contract and
 * reuse the same `(aice_id, event_key)` map row.
 */
export async function redactAndMaybeUpsertMap(
  payload: unknown,
  ctx: RedactionContext,
): Promise<{ redacted: unknown; policyVersion: string }> {
  const existing = await readMapWithLock(
    ctx.client,
    ctx.customerId,
    ctx.aiceId,
    ctx.eventKey,
  );
  let out: ReturnType<typeof redact>;
  try {
    out = redact({
      payload,
      existingMap: existing ?? {},
      ranges: ctx.ranges,
      ownedDomains: ctx.ownedDomains ?? EMPTY_OWNED_DOMAIN_SET,
      engineVersion: ENGINE_VERSION,
    });
  } catch (err) {
    // Engine has no per-event context — attach the failing
    // event_key so the route handler's
    // `redaction.injectivity_violation` audit can identify the
    // `(aice_id, event_key)` map row that needs investigation.
    if (err instanceof RedactionInjectivityError) {
      err.eventKey = ctx.eventKey;
    }
    throw err;
  }
  if (existing === null || out.mapChanged) {
    await writeMap(
      ctx.client,
      ctx.customerId,
      ctx.aiceId,
      ctx.eventKey,
      out.mergedMap,
    );
  }
  return { redacted: out.redacted, policyVersion: out.policyVersion };
}
