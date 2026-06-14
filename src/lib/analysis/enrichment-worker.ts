// RFC 0003 P1a (#361) — async IOC enrichment worker.
//
// For a story's canonical version, the worker:
//   1. extracts + normalizes indicators from the stored, already-redacted
//      member rows — both the `story_member.event` JSONB and the discrete
//      `policy_event` columns (`orig_addr`/`resp_addr`/`host`/`dns_query`/
//      `uri`) for the same event_key, which are redacted independently at
//      ingest but share the same event_redaction_map row — recovering
//      tokenized customer-asset IPs via that map,
//   2. dispatches each through the Tier-1 local-feed dispatcher (#427),
//   3. derives `known_ioc_hit` = OR over members of any match where
//      `matchSatisfiesFloor` (deterministic_ioc && floorEligible; non-public
//      IPs already forced ineligible),
//   4. UPDATEs `story.known_ioc_hit` for the canonical version (monotonic —
//      an unavailable source never flips a hit to false),
//   5. persists evidence records — one per floor-supporting match, plus
//      surfaced non-floor matches as evidence-only rows (#589 amendment):
//      floor-ineligible `deterministic_ioc` always, and `soft_reputation`
//      only when it passes the meaningfulness gate (`surfacesSoftMatch`).
//      Non-floor rows never drive `known_ioc_hit` and never change coverage,
//   6. writes the per-story `story_enrichment_state` completion marker with
//      `coverage_status` (never a silent `false` — stale/unavailable feeds
//      yield `unknown`/`stale`), written even on zero matches so
//      `false-complete` is distinguishable from `false-unknown`.
//
// The completion marker is what the story-analysis worker's precondition
// (story-worker.ts) requeues against, so analysis never reads a stale floor.
// This worker runs asynchronously after ingest and never gates raw ingest.

import "server-only";

import type { Pool } from "pg";
import { getFeedPool } from "@/lib/db/client";
import { getCustomerRuntimePool } from "@/lib/db/customer-runtime-pool";
import { ENGINE_VERSION, redact } from "@/lib/redaction/engine";
import { decryptRedactionMap } from "@/lib/redaction/envelope-adapter";
import { writeFactMap } from "@/lib/redaction/fact-map-write";
import { loadCustomerOwnedDomains } from "@/lib/redaction/load-domains";
import { loadCustomerRanges } from "@/lib/redaction/load-ranges";
import type {
  OwnedDomainSet,
  RangeSet,
  RedactionMap,
} from "@/lib/redaction/types";
import type { EnrichmentDispatcher } from "./enrichment/dispatcher";
import {
  buildEvidenceRecord,
  type EvidenceRecord,
  evidenceIsFloorSupporting,
  surfacesSoftMatch,
} from "./enrichment/evidence";
import { PgFeedStore } from "./enrichment/feed-store";
import {
  extractIndicators,
  type RecoverToken,
} from "./enrichment/indicator-extraction";
import { buildLocalFeedDispatcher } from "./enrichment/local-feed-enricher";
import { matchSatisfiesFloor } from "./enrichment/source-policy";
import type { CoverageStatus, EnrichmentFact } from "./enrichment/types";

/**
 * A fact after DB-write redaction: the redacted narrative `text` (with
 * self-scoped `<<REDACTED_*_NNN>>` tokens for customer-asset indicators,
 * external ones raw), the composite `policyVersion` it was redacted
 * under, and the self-scoped `map` (`token -> { kind, value }`) that the
 * render path decrypts to demap fact-scope tokens. The map is empty for
 * facts that referenced only external indicators.
 */
interface RedactedFact {
  text: string;
  policyVersion: string;
  map: RedactionMap;
}

// ---------------------------------------------------------------------------
// Coverage aggregation
// ---------------------------------------------------------------------------

const COVERAGE_RANK: Record<CoverageStatus, number> = {
  complete: 0,
  partial: 1,
  stale: 2,
  unknown: 3,
};

/** Most-severe-wins across per-indicator coverage statuses. */
export function worseCoverage(
  a: CoverageStatus,
  b: CoverageStatus,
): CoverageStatus {
  return COVERAGE_RANK[a] >= COVERAGE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Customer-DB reads
// ---------------------------------------------------------------------------

interface CanonicalVersion {
  storyVersion: string;
  sourceAiceId: string;
}

interface MemberEventRow {
  member_event_key: string;
  event: unknown;
}

/**
 * The canonical story version (latest by `received_at`, `story_version`
 * DESC tie-break) — identical selection to `loadCanonicalMembers` in the
 * story worker so the enrichment marker and the floor read agree on which
 * version they describe.
 */
async function loadCanonicalVersion(
  customerPool: Pool,
  storyId: string,
): Promise<CanonicalVersion | null> {
  const { rows } = await customerPool.query<{
    story_version: string;
    source_aice_id: string;
  }>(
    `SELECT story_version, source_aice_id
       FROM story
      WHERE story_id = $1::bigint
      ORDER BY received_at DESC, story_version DESC
      LIMIT 1`,
    [storyId],
  );
  if (rows.length === 0) return null;
  return {
    storyVersion: rows[0].story_version,
    sourceAiceId: rows[0].source_aice_id,
  };
}

async function loadMembers(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<MemberEventRow[]> {
  const { rows } = await customerPool.query<MemberEventRow>(
    `SELECT member_event_key::text AS member_event_key, event
       FROM story_member
      WHERE story_id = $1::bigint AND story_version = $2
      ORDER BY member_event_key`,
    [storyId, storyVersion],
  );
  return rows;
}

interface PolicyEventFields {
  orig_addr: string | null;
  resp_addr: string | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
}

/**
 * The discrete, redacted `policy_event` columns for a member's event_key.
 * These are separate storage from `story_member.event` (redacted
 * independently at ingest, per RFC 0003 §3) and can carry an indicator
 * absent from the member JSONB, so enrichment must read both. After
 * redaction the address columns are TEXT holding either a raw external IP
 * or a `<<REDACTED_IP_n>>` token (recovered via the same
 * event_redaction_map row as the member text).
 *
 * The logical event identity in this schema is `(source_aice_id,
 * event_key)`, NOT `event_key` alone — `event_key` recurs across AICE
 * sources and runs, and `policy_event` only carries `source_aice_id`
 * through its `policy_run`. So this MUST join `policy_run` and scope to the
 * canonical story's `source_aice_id`; an `event_key`-only read would let a
 * different source's `policy_event` row flip `known_ioc_hit` for the wrong
 * story. As with `baseline_event` (0002 lines 21-25), a source+event may
 * have multiple runs, so `DISTINCT ON (event_key)` keeps the latest by
 * `policy_run.received_at` (the project's "latest by received_at" dedupe).
 * Token recovery already uses `canonical.sourceAiceId`, so this also keeps
 * the typed-column read consistent with the redaction-map lookup.
 */
async function loadPolicyEventFields(
  customerPool: Pool,
  sourceAiceId: string,
  eventKey: string,
): Promise<PolicyEventFields[]> {
  const { rows } = await customerPool.query<PolicyEventFields>(
    `SELECT DISTINCT ON (pe.event_key)
            pe.orig_addr, pe.resp_addr, pe.host, pe.dns_query, pe.uri
       FROM policy_event pe
       JOIN policy_run pr ON pr.run_id = pe.run_id
      WHERE pe.event_key = $1::numeric
        AND pr.source_aice_id = $2
      ORDER BY pe.event_key, pr.received_at DESC`,
    [eventKey, sourceAiceId],
  );
  return rows;
}

/** Read + decrypt the event redaction map (no advisory lock — read-only). */
export type LoadRedactionMap = (
  customerPool: Pool,
  customerId: string,
  aiceId: string,
  eventKey: string,
) => Promise<RedactionMap | null>;

export const defaultLoadRedactionMap: LoadRedactionMap = async (
  customerPool,
  customerId,
  aiceId,
  eventKey,
) => {
  const { rows } = await customerPool.query<{
    ciphertext: Buffer;
    wrapped_dek: string;
  }>(
    `SELECT ciphertext, wrapped_dek
       FROM event_redaction_map
      WHERE aice_id = $1 AND event_key = $2::numeric`,
    [aiceId, eventKey],
  );
  if (rows.length === 0) return null;
  return decryptRedactionMap(
    customerId,
    rows[0].ciphertext,
    rows[0].wrapped_dek,
  );
};

/**
 * Build a token-recovery closure for one member's event_key. The redaction
 * map is only loaded + decrypted when `content` (the combined member JSONB
 * + policy_event columns) actually contains a token, so the common
 * (raw-only) path never touches the secret store.
 */
export async function buildRecover(
  customerPool: Pool,
  customerId: string,
  aiceId: string,
  eventKey: string,
  content: unknown,
  loadMap: LoadRedactionMap,
): Promise<RecoverToken> {
  if (!JSON.stringify(content ?? null).includes("<<REDACTED_")) {
    return () => undefined;
  }
  const map = await loadMap(customerPool, customerId, aiceId, eventKey);
  if (!map) return () => undefined;
  return (token) => map[token];
}

// ---------------------------------------------------------------------------
// Enrichment of one canonical story version
// ---------------------------------------------------------------------------

export interface EnrichmentWorkerOptions {
  authPool: Pool;
  /**
   * Pool for the dedicated feed DB backing `PgFeedStore` (#564). Optional:
   * production omits it and the default builder uses `getFeedPool()`; DB
   * tests inject an explicit test feed pool.
   */
  feedPool?: Pool;
  /** Override the customer-DB pool resolver — used by tests. */
  resolveCustomerPool?: (customerId: string) => Pool;
  /** Override the dispatcher builder — used by tests (in-memory feed store).
   * Receives the resolved feed pool (`feedPool ?? getFeedPool()`). */
  buildDispatcher?: (feedPool: Pool, now: () => Date) => EnrichmentDispatcher;
  /** Injectable clock for deterministic `checkedAt` / stale computation. */
  now?: () => Date;
  /** Override redaction-map recovery — used by tests (no OpenBao). */
  loadRedactionMap?: LoadRedactionMap;
  /**
   * Override the customer redaction-range loader (RFC 0003 C1 #440) —
   * used by tests. Drives fact redaction-at-write: customer-asset IPs in
   * a fact become self-scoped tokens.
   */
  loadRanges?: typeof loadCustomerRanges;
  /** Override the customer owned-domain loader (#440) — used by tests. */
  loadOwnedDomains?: typeof loadCustomerOwnedDomains;
}

export interface EnrichmentOutcome {
  status: "complete" | "skipped";
  knownIocHit: boolean;
  coverageStatus: CoverageStatus;
  evidenceCount: number;
  /** Number of redacted enrichment facts persisted (RFC 0003 C1 #440). */
  factCount: number;
  storyVersion?: string;
}

/**
 * Enrich one story's canonical version and persist the result. Idempotent:
 * the `known_ioc_hit` writes are monotonic OR, and re-running re-marks
 * state. Floor-supporting evidence is replaced only when the run produces
 * floor matches (so a retained monotonic `true` never loses its explaining
 * evidence); non-floor evidence (soft + floor-ineligible deterministic) is
 * replaced on every successful run (see `persistEnrichment`).
 */
export async function runStoryEnrichment(
  customerId: string,
  storyId: string,
  opts: EnrichmentWorkerOptions,
): Promise<EnrichmentOutcome> {
  const customerPool = (opts.resolveCustomerPool ?? getCustomerRuntimePool)(
    customerId,
  );
  const now = opts.now ?? (() => new Date());
  const loadMap = opts.loadRedactionMap ?? defaultLoadRedactionMap;
  const buildDispatcher =
    opts.buildDispatcher ??
    ((feedPool, clock) =>
      buildLocalFeedDispatcher(new PgFeedStore(feedPool), { now: clock }));

  const canonical = await loadCanonicalVersion(customerPool, storyId);
  if (!canonical) {
    return {
      status: "skipped",
      knownIocHit: false,
      coverageStatus: "unknown",
      evidenceCount: 0,
      factCount: 0,
    };
  }

  // Once the canonical version is known, any hard failure (redaction-map
  // decryption, DB error) must leave a VISIBLE, recoverable
  // marker. Without it the analysis precondition would requeue forever with
  // nothing but process logs to explain the stall. A `failed` marker is
  // recoverable: a later successful run flips it back to `complete`.
  try {
    return await enrichCanonicalVersion(customerPool, {
      customerId,
      storyId,
      canonical,
      now,
      loadMap,
      buildDispatcher: () =>
        buildDispatcher(opts.feedPool ?? getFeedPool(), now),
      authPool: opts.authPool,
      loadRanges: opts.loadRanges ?? loadCustomerRanges,
      loadOwnedDomains: opts.loadOwnedDomains ?? loadCustomerOwnedDomains,
    });
  } catch (err) {
    await persistEnrichmentFailure(customerPool, {
      storyId,
      storyVersion: canonical.storyVersion,
      error: err,
    }).catch((markErr) => {
      console.error(
        "[enrichment-worker] failed to persist enrichment-failure marker:",
        markErr,
      );
    });
    throw err;
  }
}

interface EnrichCanonicalArgs {
  customerId: string;
  storyId: string;
  canonical: CanonicalVersion;
  now: () => Date;
  loadMap: LoadRedactionMap;
  buildDispatcher: () => EnrichmentDispatcher;
  authPool: Pool;
  loadRanges: typeof loadCustomerRanges;
  loadOwnedDomains: typeof loadCustomerOwnedDomains;
}

/** Run the dispatch + persist for one canonical version (throws on hard error). */
async function enrichCanonicalVersion(
  customerPool: Pool,
  args: EnrichCanonicalArgs,
): Promise<EnrichmentOutcome> {
  const { customerId, storyId, canonical, now, loadMap } = args;
  const members = await loadMembers(
    customerPool,
    storyId,
    canonical.storyVersion,
  );
  const dispatcher = args.buildDispatcher();
  const checkedAt = now().toISOString();

  let knownIocHit = false;
  // No indicators to check means nothing was missed — complete coverage.
  let coverage: CoverageStatus = "complete";
  const evidence: EvidenceRecord[] = [];
  // RFC 0003 C1 (#440) — narrative facts across ALL matches (incl.
  // `soft_reputation` / floor-ineligible), accumulated raw then redacted
  // once below at the DB-write boundary. The same indicator can recur
  // across members (e.g. one C2 IP seen in many events), each producing
  // an identical fact; dedup by raw text so the prompt and the persisted
  // fact rows carry each narrative once.
  const rawFacts: EnrichmentFact[] = [];
  const seenFactText = new Set<string>();

  for (const member of members) {
    // Combine both redacted sources for this event_key: the member JSONB
    // and the discrete policy_event columns (RFC 0003 §3). They are
    // redacted independently at ingest but share one event_redaction_map
    // row, so a single recover closure covers tokens from either. Nulls
    // and the nested object are walked uniformly by `extractIndicators`.
    const policyRows = await loadPolicyEventFields(
      customerPool,
      canonical.sourceAiceId,
      member.member_event_key,
    );
    const sources: unknown[] = [member.event];
    for (const p of policyRows) {
      sources.push(p.orig_addr, p.resp_addr, p.host, p.dns_query, p.uri);
    }
    const recover = await buildRecover(
      customerPool,
      customerId,
      canonical.sourceAiceId,
      member.member_event_key,
      sources,
      loadMap,
    );
    for (const { indicator, redactionToken } of extractIndicators(
      sources,
      recover,
    )) {
      const merged = await dispatcher.dispatch(indicator);
      coverage = worseCoverage(coverage, merged.coverage.status);
      // Collect every fact the dispatch produced (narrative for all
      // matches, not just the floor-supporting ones below), skipping
      // exact-text duplicates already gathered from another member.
      for (const fact of merged.facts) {
        if (seenFactText.has(fact.text)) continue;
        seenFactText.add(fact.text);
        rawFacts.push(fact);
      }
      for (const match of merged.matches) {
        // Floor-supporting matches drive the binary floor exactly as before.
        // Non-floor matches are now ALSO promoted to evidence — by class
        // (#589 Scope 1): floor-ineligible `deterministic_ioc` always (a
        // curated known-bad hit, evidence-only); `soft_reputation` only when
        // it passes the meaningfulness gate. The floor invariant is untouched:
        // only `matchSatisfiesFloor` flips `knownIocHit`.
        const floorSupporting = matchSatisfiesFloor(match);
        if (floorSupporting) {
          knownIocHit = true;
        } else if (match.hitType === "soft_reputation") {
          // Gate the structured/cited surface only (#589 Scope 3). A
          // below-gate soft match stays in the (ungated) fact channel above
          // (#440) and primes the LLM; it just gets no evidence row. Log the
          // not-promoted decision so it is observable. No raw indicator is
          // logged (privacy) — only source/confidence/event-scope.
          if (!surfacesSoftMatch(match, merged.matches)) {
            console.info(
              "[enrichment-worker] soft_reputation match not promoted to " +
                "evidence (below meaningfulness gate)",
              {
                sourcePolicyId: match.sourcePolicyId,
                confidence: match.confidence,
                memberEventKey: member.member_event_key,
              },
            );
            continue;
          }
        }
        evidence.push(
          buildEvidenceRecord({
            match,
            redactionToken,
            // The `(aice_id, event_key)` scope that recovers a
            // customer-asset token (the original lives only in that
            // event_redaction_map row); provenance for a raw external one.
            sourceAiceId: canonical.sourceAiceId,
            memberEventKey: member.member_event_key,
            checkedAt,
            expiresAt: merged.expiresAt,
            coverage: merged.coverage,
          }),
        );
      }
    }
  }

  // Redact each fact's text at the DB-write boundary (RFC 0001 Amendment
  // A.1, fact side). External indicators stay raw; customer-asset IPs (in
  // a registered range) and owned domains become self-scoped tokens whose
  // raw value lives only in the per-fact encrypted map. Policy is loaded
  // once and shared — facts in one story redact under one policy version.
  const redactedFacts = await redactFacts(
    rawFacts,
    args.authPool,
    customerId,
    args.loadRanges,
    args.loadOwnedDomains,
  );

  await persistEnrichment(customerPool, {
    customerId,
    storyId,
    storyVersion: canonical.storyVersion,
    knownIocHit,
    coverage,
    evidence,
    redactedFacts,
    completedAt: checkedAt,
  });

  return {
    status: "complete",
    knownIocHit,
    coverageStatus: coverage,
    evidenceCount: evidence.length,
    factCount: redactedFacts.length,
    storyVersion: canonical.storyVersion,
  };
}

/**
 * Redact every accumulated fact's text via the pure redaction engine
 * (RFC 0003 C1 #440). Loads the customer's ranges + owned domains once
 * (skipped entirely when there are no facts, so a story with no IOC
 * matches never touches the policy tables). Each fact gets its OWN
 * self-scoped map (`existingMap: {}`), so token numbering restarts per
 * fact and the map carries no cross-fact/story linkage.
 */
async function redactFacts(
  rawFacts: ReadonlyArray<EnrichmentFact>,
  authPool: Pool,
  customerId: string,
  loadRanges: typeof loadCustomerRanges,
  loadOwnedDomains: typeof loadCustomerOwnedDomains,
): Promise<RedactedFact[]> {
  if (rawFacts.length === 0) return [];
  let ranges: RangeSet;
  let ownedDomains: OwnedDomainSet;
  try {
    ranges = await loadRanges(authPool, customerId);
    ownedDomains = await loadOwnedDomains(authPool, customerId);
  } catch (err) {
    // A policy-load failure must not silently drop facts to raw plaintext
    // (which could leak a customer-asset value into the prompt). Fail the
    // run; the visible `failed` marker lets it recover on a later tick.
    throw err instanceof Error
      ? err
      : new Error(
          `enrichment: failed to load redaction policy: ${String(err)}`,
        );
  }
  return rawFacts.map((fact) => {
    const { redacted, mergedMap, policyVersion } = redact({
      payload: fact.text,
      existingMap: {},
      ranges,
      ownedDomains,
      engineVersion: ENGINE_VERSION,
    });
    return {
      text: typeof redacted === "string" ? redacted : fact.text,
      policyVersion,
      map: mergedMap,
    };
  });
}

interface PersistArgs {
  customerId: string;
  storyId: string;
  storyVersion: string;
  knownIocHit: boolean;
  coverage: CoverageStatus;
  evidence: readonly EvidenceRecord[];
  redactedFacts: readonly RedactedFact[];
  completedAt: string;
}

async function persistEnrichment(
  customerPool: Pool,
  args: PersistArgs,
): Promise<void> {
  const client = await customerPool.connect();
  try {
    await client.query("BEGIN");

    // Monotonic floor write: never flip an observed hit back to false.
    await client.query(
      `UPDATE story
          SET known_ioc_hit = known_ioc_hit OR $3
        WHERE story_id = $1::bigint AND story_version = $2`,
      [args.storyId, args.storyVersion, args.knownIocHit],
    );

    // Evidence is replaced CLASS-PARTITIONED (#589 Scope 2a), because the
    // array now carries both floor-supporting rows AND non-floor rows (soft +
    // floor-ineligible deterministic) with different monotonicity guarantees.
    //
    //   * Floor-supporting rows (`deterministic_ioc AND floor_eligible`) keep
    //     the original monotonic semantics: a `true` floor must stay
    //     explainable. Replace them ONLY when this run itself produced
    //     floor-supporting matches (those are fresh and accurate for the
    //     retained `true`). A run with NO floor hit (feed unavailable, IOC
    //     delisted, policy made ineligible) leaves prior floor rows in place —
    //     the `known_ioc_hit OR` above keeps a prior `true`, so deleting its
    //     evidence would leave a `true` floor with nothing behind it.
    //   * Non-floor rows have no monotonic guarantee (like facts): replace
    //     them on EVERY successful run — not gated on evidence count — so a
    //     successful run that promotes zero non-floor evidence still CLEARS
    //     stale non-floor rows from a prior run, while the floor rows survive.
    const producedFloorEvidence = args.evidence.some(evidenceIsFloorSupporting);
    if (producedFloorEvidence) {
      await client.query(
        `DELETE FROM story_ioc_evidence
          WHERE story_id = $1::bigint AND story_version = $2
            AND hit_type = 'deterministic_ioc' AND floor_eligible = TRUE`,
        [args.storyId, args.storyVersion],
      );
    }
    await client.query(
      `DELETE FROM story_ioc_evidence
        WHERE story_id = $1::bigint AND story_version = $2
          AND NOT (hit_type = 'deterministic_ioc' AND floor_eligible = TRUE)`,
      [args.storyId, args.storyVersion],
    );
    for (const e of args.evidence) {
      await client.query(
        `INSERT INTO story_ioc_evidence
           (story_id, story_version, redaction_token,
            source_aice_id, member_event_key,
            source_policy_id, source_version, feed_hash, source_updated_at,
            hit_type, floor_eligible, coverage_status, checked_at, expires_at)
         VALUES ($1::bigint, $2, $3, $4, $5::numeric, $6, $7, $8,
                 $9::timestamptz, $10, $11, $12, $13::timestamptz,
                 $14::timestamptz)`,
        [
          args.storyId,
          args.storyVersion,
          e.redactionToken,
          e.sourceAiceId,
          e.memberEventKey,
          e.sourcePolicyId,
          e.sourceVersion ?? null,
          e.feedHash ?? null,
          e.sourceUpdatedAt ?? null,
          e.hitType,
          e.floorEligible,
          e.coverage?.status ?? null,
          e.checkedAt,
          e.expiresAt ?? null,
        ],
      );
    }

    // Enrichment facts (RFC 0003 C1 #440). Always replace this version's
    // facts with the current run's: unlike the monotonic floor / evidence,
    // facts are pure narrative derived from the latest dispatch and carry
    // no monotonic guarantee, so the freshest set is authoritative. The
    // DELETE cascades to `enrichment_redaction_map`. Each fact gets a new
    // IDENTITY `fact_id`; its self-scoped map is written only when it
    // actually has customer-asset tokens, so external-only facts never
    // touch the envelope encryptor.
    await client.query(
      `DELETE FROM story_enrichment_fact
        WHERE story_id = $1::bigint AND story_version = $2`,
      [args.storyId, args.storyVersion],
    );
    for (const fact of args.redactedFacts) {
      const inserted = await client.query<{ fact_id: string }>(
        `INSERT INTO story_enrichment_fact
           (story_id, story_version, fact_text, redaction_policy_version)
         VALUES ($1::bigint, $2, $3, $4)
         RETURNING fact_id::text AS fact_id`,
        [args.storyId, args.storyVersion, fact.text, fact.policyVersion],
      );
      if (Object.keys(fact.map).length > 0) {
        await writeFactMap(
          client,
          args.customerId,
          inserted.rows[0].fact_id,
          fact.map,
        );
      }
    }

    // Completion marker — written even on zero matches. `known_ioc_hit` is
    // monotonic OR; `coverage_status` reflects the latest run.
    await client.query(
      `INSERT INTO story_enrichment_state
         (story_id, story_version, status, coverage_status, known_ioc_hit,
          completed_at)
       VALUES ($1::bigint, $2, 'complete', $3, $4, $5::timestamptz)
       ON CONFLICT (story_id, story_version) DO UPDATE SET
         status         = 'complete',
         coverage_status = EXCLUDED.coverage_status,
         known_ioc_hit  = story_enrichment_state.known_ioc_hit
                          OR EXCLUDED.known_ioc_hit,
         completed_at   = EXCLUDED.completed_at,
         last_error     = NULL,
         updated_at     = NOW()`,
      [
        args.storyId,
        args.storyVersion,
        args.coverage,
        args.knownIocHit,
        args.completedAt,
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a hard enrichment failure as a VISIBLE, recoverable
 * `story_enrichment_state` row so the analysis precondition's requeue is no
 * longer an invisible stall: operators see `status = 'failed'` and the
 * `last_error`. Monotonic-safe — a prior `complete` (and its observed
 * `known_ioc_hit`) is never downgraded, so a transient failure after a good
 * run cannot un-ready a story; only a never-completed version is marked
 * `failed`. A subsequent successful run flips it back to `complete`.
 */
async function persistEnrichmentFailure(
  customerPool: Pool,
  args: { storyId: string; storyVersion: string; error: unknown },
): Promise<void> {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  await customerPool.query(
    `INSERT INTO story_enrichment_state
       (story_id, story_version, status, coverage_status, known_ioc_hit,
        last_error)
     VALUES ($1::bigint, $2, 'failed', 'unknown', FALSE, $3)
     ON CONFLICT (story_id, story_version) DO UPDATE SET
       status          = CASE WHEN story_enrichment_state.status = 'complete'
                              THEN 'complete' ELSE 'failed' END,
       coverage_status = CASE WHEN story_enrichment_state.status = 'complete'
                              THEN story_enrichment_state.coverage_status
                              ELSE 'unknown' END,
       known_ioc_hit   = story_enrichment_state.known_ioc_hit,
       last_error      = EXCLUDED.last_error,
       updated_at      = NOW()`,
    [args.storyId, args.storyVersion, message.slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Tick — drive enrichment for stories about to be analyzed
// ---------------------------------------------------------------------------

// Advisory-lock namespace distinct from the story-analysis worker's pair
// so the two never contend on the same keys.
const ENRICHMENT_LOCK_NS = 0x361a;

function enrichmentLockId2(customerId: string, storyId: string): number {
  let hash = 0;
  for (const ch of `${customerId}/${storyId}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) | 1;
}

/**
 * Enrich up to `limit` stories that have a queued (real) analysis job but
 * no completed enrichment for their canonical version. Runs BEFORE the
 * story-analysis dispatch in the poll loop so enrichment usually lands
 * first; the analysis-worker precondition is the actual ordering
 * guarantee, so a story not reached here simply requeues. Returns the
 * number of stories enriched.
 */
export async function tickStoryEnrichmentOnce(
  authPool: Pool,
  limit: number,
  opts: EnrichmentWorkerOptions = { authPool },
): Promise<number> {
  const { rows: candidates } = await authPool.query<{
    customer_id: string;
    story_id: string;
  }>(
    `SELECT DISTINCT s.customer_id::text AS customer_id,
            s.story_id::text             AS story_id
       FROM story_analysis_state s
       JOIN story_analysis_job j
         ON j.customer_id = s.customer_id AND j.story_id = s.story_id
      WHERE j.status = 'queued' AND j.dry_run = FALSE
      ORDER BY s.customer_id::text, s.story_id::text
      LIMIT $1`,
    [limit],
  );

  const resolve = opts.resolveCustomerPool ?? getCustomerRuntimePool;
  let enriched = 0;
  for (const candidate of candidates) {
    // Per-candidate failures (e.g. an unresolvable customer pool) must
    // never break the analysis loop — log and move on. A hard failure
    // reached after the canonical version is known has already persisted a
    // visible `failed` marker (see `runStoryEnrichment`); the analysis
    // precondition reports that state and keeps requeuing (recoverably).
    try {
      const customerPool = resolve(candidate.customer_id);
      const canonical = await loadCanonicalVersion(
        customerPool,
        candidate.story_id,
      );
      if (!canonical) continue;
      if (
        await isEnrichmentComplete(
          customerPool,
          candidate.story_id,
          canonical.storyVersion,
        )
      ) {
        continue;
      }
      if (await enrichUnderLock(authPool, candidate, opts)) {
        enriched += 1;
      }
    } catch (err) {
      console.error("[enrichment-worker] enrichment candidate failed:", err);
    }
  }
  return enriched;
}

/**
 * Acquire the per-story advisory lock and run enrichment. Returns whether
 * enrichment ran (false if the lock was already held by another worker).
 */
async function enrichUnderLock(
  authPool: Pool,
  candidate: { customer_id: string; story_id: string },
  opts: EnrichmentWorkerOptions,
): Promise<boolean> {
  const lockId2 = enrichmentLockId2(candidate.customer_id, candidate.story_id);
  const lockClient = await authPool.connect();
  try {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1, $2) AS locked`,
      [ENRICHMENT_LOCK_NS, lockId2],
    );
    if (!lockRes.rows[0]?.locked) return false;
    try {
      await runStoryEnrichment(candidate.customer_id, candidate.story_id, opts);
      return true;
    } finally {
      await lockClient
        .query(`SELECT pg_advisory_unlock($1, $2)`, [
          ENRICHMENT_LOCK_NS,
          lockId2,
        ])
        .catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

async function isEnrichmentComplete(
  customerPool: Pool,
  storyId: string,
  storyVersion: string,
): Promise<boolean> {
  const { rows } = await customerPool.query<{ status: string }>(
    `SELECT status
       FROM story_enrichment_state
      WHERE story_id = $1::bigint AND story_version = $2`,
    [storyId, storyVersion],
  );
  return rows[0]?.status === "complete";
}

export const __testables = {
  loadCanonicalVersion,
  worseCoverage,
  enrichmentLockId2,
  ENRICHMENT_LOCK_NS,
} satisfies Record<string, unknown>;
