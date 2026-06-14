// Server-side loader for the TI IOC evidence + feed-source citation surface
// (#591). Reads BOTH the per-story/event enrichment-state row (the verdict +
// coverage authority — present even with zero evidence) AND the supporting
// `*_ioc_evidence` rows, resolving each evidence row to a display-ready
// {@link IocEvidenceItem}: source label, provenance, and a redaction-consistent
// indicator de-mapped strictly within its own `(source_aice_id,
// member_event_key/event_key)` scope.
//
// Read-only consumer — it never writes evidence (that is #589's worker path).
// Both helpers take the already-checked-out customer pool from the calling
// page loader, so authorization stays where it is (the page loaders already
// gate `analyses:read`).

import "server-only";

import { decryptRedactionMap, type RedactionMap } from "@/lib/redaction";
// `feed-catalog` imports the source barrel (`./sources`), so importing it here
// guarantees every `TiSourceDescriptor` is registered before a label lookup.
import { getTier1FeedSource } from "./enrichment/feed-catalog";
import {
  type CoverageStatus,
  classifyEvidence,
  type IocEnrichment,
  type IocEnrichmentVerdict,
  type IocEvidenceItem,
  isRedactionToken,
  NOT_RUN_IOC_ENRICHMENT,
} from "./ioc-evidence";
import { restoreRedactedTokens } from "./restore";

// Minimal pg Pool surface — matches the page loaders' own annotation.
// biome-ignore lint/suspicious/noExplicitAny: pg Pool minimal surface
type Pool = any;

/** One raw `*_ioc_evidence` row in the shape the SELECTs below return. */
interface EvidenceRow {
  redaction_token: string;
  source_aice_id: string;
  // `member_event_key` (story) / `event_key` (event), both selected `::text`.
  scope_event_key: string;
  source_policy_id: string;
  source_version: string | null;
  feed_hash: string | null;
  hit_type: "deterministic_ioc" | "soft_reputation";
  floor_eligible: boolean;
  coverage_status: CoverageStatus | null;
  checked_at: Date;
}

/**
 * Resolve the IOC-enrichment surface for a story's CURRENT CANONICAL
 * `(story_id, story_version)` (#498 precedent). `story_analysis_result`
 * carries no `story_version`, so the canonical version is resolved by the
 * worker's rule (`received_at DESC, story_version DESC`) and the
 * `story_enrichment_state` / `story_ioc_evidence` rows are joined on it —
 * the SAME resolution the #498 coverage join already used.
 *
 * The verdict is present only when a `story_enrichment_state` row exists with
 * `status = 'complete'`: an absent row (a canonical version never enriched) or
 * a `failed` row (a hard error left the run incomplete — "not checked yet",
 * matching the #498 treatment) is returned as `verdict: null` (not run),
 * NEVER coerced to a clean `complete` verdict.
 */
export async function loadStoryIocEnrichment(
  customerPool: Pool,
  customerId: string,
  storyId: string,
): Promise<IocEnrichment> {
  const { rows } = await customerPool.query(
    `SELECT s.story_version::text AS story_version,
            ses.status          AS status,
            ses.known_ioc_hit   AS known_ioc_hit,
            ses.coverage_status AS coverage_status
       FROM story s
       LEFT JOIN story_enrichment_state ses
         ON ses.story_id = s.story_id
        AND ses.story_version = s.story_version
      WHERE s.story_id = $1::bigint
      ORDER BY s.received_at DESC, s.story_version DESC
      LIMIT 1`,
    [storyId],
  );
  if (rows.length === 0) return NOT_RUN_IOC_ENRICHMENT;
  const canonical = rows[0] as {
    story_version: string;
    status: "complete" | "failed" | null;
    known_ioc_hit: boolean | null;
    coverage_status: CoverageStatus | null;
  };
  const verdict = verdictFromState(
    canonical.status,
    canonical.known_ioc_hit,
    canonical.coverage_status,
  );

  const evidence = await customerPool.query(
    `SELECT redaction_token,
            source_aice_id,
            member_event_key::text AS scope_event_key,
            source_policy_id,
            source_version,
            feed_hash,
            hit_type,
            floor_eligible,
            coverage_status,
            checked_at
       FROM story_ioc_evidence
      WHERE story_id = $1::bigint AND story_version = $2
      ORDER BY created_at`,
    [storyId, canonical.story_version],
  );
  const items = await resolveEvidence(
    customerPool,
    customerId,
    evidence.rows as EvidenceRow[],
  );
  return { verdict, evidence: items };
}

/**
 * Resolve the IOC-enrichment surface for an event, keyed on
 * `(source_aice_id, event_key)`. The verdict comes from
 * `event_enrichment_state`; a MANUALLY-analyzed event (never auto-baselined,
 * RFC 0002 #489) has NO state row, so it returns `verdict: null` (not run) —
 * never a clean `complete` verdict.
 *
 * Every `event_ioc_evidence` row for an event shares that single event scope,
 * so the page's already-decrypted `event_redaction_map` (passed as
 * `pageMap`, keyed on the page's `(aiceId, eventKey)`) de-maps the indicators
 * with no extra decrypt. A row whose scope does not match the page event (a
 * defensive case — the SELECT filters on exactly this event) falls back to
 * token-only display rather than de-mapping cross-scope.
 */
export async function loadEventIocEnrichment(
  customerPool: Pool,
  aiceId: string,
  eventKey: string,
  pageMap: RedactionMap,
): Promise<IocEnrichment> {
  const stateRes = await customerPool.query(
    `SELECT status, known_ioc_hit, coverage_status
       FROM event_enrichment_state
      WHERE source_aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  const stateRow = stateRes.rows[0] as
    | {
        status: "complete" | "failed";
        known_ioc_hit: boolean | null;
        coverage_status: CoverageStatus | null;
      }
    | undefined;
  const verdict = verdictFromState(
    stateRow?.status ?? null,
    stateRow?.known_ioc_hit ?? null,
    stateRow?.coverage_status ?? null,
  );

  const evidence = await customerPool.query(
    `SELECT redaction_token,
            source_aice_id,
            event_key::text AS scope_event_key,
            source_policy_id,
            source_version,
            feed_hash,
            hit_type,
            floor_eligible,
            coverage_status,
            checked_at
       FROM event_ioc_evidence
      WHERE source_aice_id = $1 AND event_key = $2::numeric
      ORDER BY created_at`,
    [aiceId, eventKey],
  );
  // The page event's map is the only scope an event's evidence rows carry.
  const scopeMaps = new Map<string, RedactionMap>([
    [scopeKey(aiceId, eventKey), pageMap],
  ]);
  const items = (evidence.rows as EvidenceRow[]).map((row) =>
    buildItem(row, scopeMaps),
  );
  return { verdict, evidence: items };
}

// A verdict is meaningful only on a COMPLETED enrichment run. An absent row or
// a `failed` row yields `null` (not run / unavailable), never a clean verdict.
function verdictFromState(
  status: "complete" | "failed" | null,
  knownIocHit: boolean | null,
  coverageStatus: CoverageStatus | null,
): IocEnrichmentVerdict | null {
  if (status !== "complete" || coverageStatus === null) return null;
  return { knownIocHit: knownIocHit === true, coverageStatus };
}

// Resolve a batch of evidence rows: decrypt each distinct
// `(source_aice_id, member_event_key)` redaction-map scope ONCE (only for rows
// whose indicator is actually a token), then build the display items.
async function resolveEvidence(
  customerPool: Pool,
  customerId: string,
  rows: EvidenceRow[],
): Promise<IocEvidenceItem[]> {
  if (rows.length === 0) return [];
  const scopeMaps = await loadScopeMaps(customerPool, customerId, rows);
  return rows.map((row) => buildItem(row, scopeMaps));
}

// Decrypt the `event_redaction_map` for every distinct scope referenced by a
// TOKEN-bearing evidence row (raw external indicators need no map). One
// batched SELECT covers all scopes; a decrypt failure (KEK rotation / vault
// outage) simply omits that scope, so its tokens degrade to token-only.
async function loadScopeMaps(
  customerPool: Pool,
  customerId: string,
  rows: EvidenceRow[],
): Promise<Map<string, RedactionMap>> {
  const scopes = new Map<string, { aiceId: string; eventKey: string }>();
  for (const row of rows) {
    if (!isRedactionToken(row.redaction_token)) continue;
    scopes.set(scopeKey(row.source_aice_id, row.scope_event_key), {
      aiceId: row.source_aice_id,
      eventKey: row.scope_event_key,
    });
  }
  const maps = new Map<string, RedactionMap>();
  if (scopes.size === 0) return maps;

  const list = [...scopes.values()];
  const mapRows = await customerPool.query(
    `SELECT aice_id::text AS aice_id,
            event_key::text AS event_key,
            ciphertext, wrapped_dek
       FROM event_redaction_map
      WHERE (aice_id, event_key) IN (${list
        .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::numeric)`)
        .join(", ")})`,
    list.flatMap((s) => [s.aiceId, s.eventKey]),
  );
  for (const r of mapRows.rows as Array<{
    aice_id: string;
    event_key: string;
    ciphertext: Buffer;
    wrapped_dek: string;
  }>) {
    try {
      const map = await decryptRedactionMap(
        customerId,
        r.ciphertext,
        r.wrapped_dek,
      );
      maps.set(scopeKey(r.aice_id, r.event_key), map);
    } catch {
      // Decrypt failure — omit this scope; its tokens degrade to token-only.
    }
  }
  return maps;
}

// Build one display item, de-mapping a token indicator strictly within its
// own scope's map and degrading to token-only when the map is unavailable.
function buildItem(
  row: EvidenceRow,
  scopeMaps: Map<string, RedactionMap>,
): IocEvidenceItem {
  const floorEligible = row.floor_eligible === true;
  let indicator = row.redaction_token;
  let indicatorRedacted = false;
  if (isRedactionToken(row.redaction_token)) {
    // A customer-asset token: recover the original ONLY within its carried
    // scope. Cross-scope de-map is never attempted (token numbering restarts
    // per event); an unavailable map leaves the bare token (safe degrade).
    indicatorRedacted = true;
    const map = scopeMaps.get(
      scopeKey(row.source_aice_id, row.scope_event_key),
    );
    if (map) {
      const restored = restoreRedactedTokens(row.redaction_token, map);
      if (restored !== row.redaction_token) {
        indicator = restored;
        indicatorRedacted = false;
      }
    }
  }
  return {
    indicator,
    indicatorRedacted,
    sourceAiceId: row.source_aice_id,
    memberEventKey: row.scope_event_key,
    // Unknown `source_policy_id` (a policy retired since the row was written)
    // falls back to the id itself — never failing or dropping the row.
    sourceLabel:
      getTier1FeedSource(row.source_policy_id)?.label ?? row.source_policy_id,
    sourcePolicyId: row.source_policy_id,
    hitType: row.hit_type,
    floorEligible,
    evidenceClass: classifyEvidence({
      hitType: row.hit_type,
      floorEligible,
    }),
    coverageStatus: row.coverage_status ?? null,
    sourceVersion: row.source_version ?? null,
    feedHash: row.feed_hash ?? null,
    checkedAt: row.checked_at,
  };
}

function scopeKey(aiceId: string, eventKey: string): string {
  return `${aiceId}:${eventKey}`;
}
