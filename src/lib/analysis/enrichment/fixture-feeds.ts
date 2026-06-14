// RFC 0003 P1a (#361) — the committed, pinned Tier-1 feed fixtures, now
// expressed as a `FixtureFeedSource` (#564).
//
// These fixtures (`./feeds/*`) are the offline stand-in for live feed
// downloads (RFC 0003 §"Testing" — "fixtures are pinned local snapshots,
// never live feeds"). Tests and local dev seed from them. `manual-upload`
// (part 2, #566) is NOT a `FeedSource`: operator uploads enter through the
// admin route, which calls the common downstream (`importRawFeedPayload`)
// directly. The pull-based `FeedSource` seam is used only by the later
// fetch modes (self-fetch, managed).
//
// `FixtureFeedSource` is the `fixture` supply mode: it yields the raw feed
// bytes (read from disk) + provenance, and the common downstream
// (`importFromFeedSource`) parses/normalizes/imports them. This is the
// test/dev-only seeding path — production imports come from the operator
// upload route (`manual-upload`) or the later fetch sources, never this
// module.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { importFromFeedSource } from "./feed-import";
import {
  type FeedParseKind,
  type FeedSource,
  type RawFeedPayload,
  resolveTiFeedMode,
  type TiFeedMode,
} from "./feed-source";
import "./sources";
import { allTiSourceDescriptors } from "./sources/registry";
import type { EntityType, HitType } from "./types";

const FEEDS_DIR = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
);

interface FixtureFeedSpec {
  sourcePolicyId: string;
  file: string;
  parse: FeedParseKind;
  entityType: EntityType;
  hitType: HitType;
  classification?: string;
}

/**
 * Manifest of the committed Tier-1 fixtures and how to import each. Derived
 * from the self-registering source registry (#588): every source that declares
 * a `fixtureFile` contributes one spec, re-attaching its
 * `parse/entityType/hitType/classification` mapping so the manifest is defined
 * once and the upload feature reads the same values. Order follows the
 * registry's deterministic stable-by-id ordering.
 */
export const FIXTURE_FEEDS: readonly FixtureFeedSpec[] =
  allTiSourceDescriptors()
    .filter((descriptor) => descriptor.fixtureFile !== undefined)
    .map((descriptor) => ({
      sourcePolicyId: descriptor.sourcePolicyId,
      file: descriptor.fixtureFile as string,
      parse: descriptor.parse,
      entityType: descriptor.entityType,
      hitType: descriptor.hitType,
      classification: descriptor.classification,
    }));

/** Options stamping fixture provenance (freshness drives stale coverage). */
export interface FixtureFeedSourceOptions {
  /** ISO timestamp of the snapshot's freshness — pass relative to the test
   * clock to control fresh vs stale coverage. */
  sourceUpdatedAt: string;
  sourceVersion?: string;
}

/**
 * The committed-fixture `FeedSource` (mode `fixture`). Reads `./feeds/*`
 * from disk and yields each as a raw payload + provenance; the common
 * downstream (`importFromFeedSource`) parses/normalizes/imports them. No
 * behavior change from the prior direct-seed path — it still reads the same
 * files and produces the same `ioc_feed_snapshot` rows.
 */
export class FixtureFeedSource implements FeedSource {
  readonly mode: TiFeedMode = "fixture";

  constructor(private readonly options: FixtureFeedSourceOptions) {}

  async loadPayloads(): Promise<RawFeedPayload[]> {
    return FIXTURE_FEEDS.map((spec) => {
      const path = join(FEEDS_DIR, spec.file);
      return {
        sourcePolicyId: spec.sourcePolicyId,
        parse: spec.parse,
        entityType: spec.entityType,
        hitType: spec.hitType,
        classification: spec.classification,
        content: readFileSync(path, "utf8"),
        provenance: {
          mode: this.mode,
          origin: path,
          sourceUpdatedAt: this.options.sourceUpdatedAt,
          sourceVersion: this.options.sourceVersion,
        },
      };
    });
  }
}

/**
 * Seed every fixture feed into `ioc_feed_snapshot` (replace-all per
 * source) via the `FixtureFeedSource`. `sourceUpdatedAt` stamps the
 * snapshot freshness — pass a value relative to the test clock to control
 * fresh vs stale coverage.
 */
export async function seedFixtureFeeds(
  pool: Pool,
  options: FixtureFeedSourceOptions,
): Promise<void> {
  await importFromFeedSource(pool, new FixtureFeedSource(options));
}

/**
 * Resolve the deployment's configured `FeedSource` from `TI_FEED_MODE`.
 *
 * This is the single mode→source dispatch point for the *pull-based* supply
 * modes: the later parts add their case here (returning their `FeedSource`
 * for `self-fetch` / `managed`) instead of teaching every import caller a new
 * mode. Callers go through this seam rather than constructing a `FeedSource`
 * directly, so the env actually selects the supply mode.
 *
 * `manual-upload` (part 2) and `self-fetch` (part 3a, #568) are intentionally
 * **not** wired here. Both are operator-triggered: an upload / "Fetch Now"
 * enters through the admin route, which calls `importRawFeedPayload()` (upload)
 * or `SelfFetchFeedSource.fetchAndImport()` (self-fetch) directly. Both modes
 * are supported by `resolveTiFeedMode()`, so if this function were invoked in
 * either mode it would (correctly) fall to the `default` branch. The pull
 * -based scheduler that WOULD route self-fetch through this seam is deferred
 * to part 3b.
 *
 * `resolveTiFeedMode()` already fails fast on unknown or not-yet
 * -implemented modes; the `default` branch only guards against a mode being
 * promoted into `SUPPORTED_TI_FEED_MODES` without a pull-based case wired
 * here (which is the expected state for `manual-upload`).
 *
 * (Lives here, not in `feed-source.ts`, to avoid a cycle: this module
 * already depends on the source types and the concrete `FixtureFeedSource`.)
 */
export function resolveConfiguredFeedSource(
  options: FixtureFeedSourceOptions,
  modeValue: string | undefined = process.env.TI_FEED_MODE,
): FeedSource {
  // Validate + narrow through the resolver so an explicit override gets the
  // same fail-fast treatment (unknown / reserved-unimplemented) as the env.
  const mode = resolveTiFeedMode(modeValue);
  switch (mode) {
    case "fixture":
      return new FixtureFeedSource(options);
    default:
      throw new Error(`No FeedSource wired for TI_FEED_MODE "${mode}" yet`);
  }
}

/**
 * Import the deployment's configured feed source (selected by
 * `TI_FEED_MODE`) into `ioc_feed_snapshot`. The mode-independent
 * `seedFixtureFeeds` stays the deterministic test/dev fixture path; this is
 * the env-driven entry that parts 2-4 extend via
 * `resolveConfiguredFeedSource`.
 */
export async function importConfiguredFeed(
  pool: Pool,
  options: FixtureFeedSourceOptions,
): Promise<void> {
  await importFromFeedSource(pool, resolveConfiguredFeedSource(options));
}
