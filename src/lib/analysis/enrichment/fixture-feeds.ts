// RFC 0003 P1a (#361) — the committed, pinned Tier-1 feed fixtures, now
// expressed as a `FixtureFeedSource` (#564).
//
// These fixtures (`./feeds/*`) are the offline stand-in for live feed
// downloads (RFC 0003 §"Testing" — "fixtures are pinned local snapshots,
// never live feeds"). Tests and local dev seed from them; the later supply
// modes (manual-upload, self-fetch, managed) are separate `FeedSource`
// implementations in this series.
//
// `FixtureFeedSource` is the `fixture` supply mode: it yields the raw feed
// bytes (read from disk) + provenance, and the common downstream
// (`importFromFeedSource`) parses/normalizes/imports them. This is the
// test/dev-only seeding path — production imports come from the (future)
// upload/fetch sources, never this module.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { importFromFeedSource } from "./feed-import";
import type {
  FeedParseKind,
  FeedSource,
  RawFeedPayload,
  TiFeedMode,
} from "./feed-source";
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

/** Manifest of the committed Tier-1 fixtures and how to import each. */
export const FIXTURE_FEEDS: readonly FixtureFeedSpec[] = [
  {
    sourcePolicyId: "abuse.ch/feodo",
    file: "feodo-ipblocklist.txt",
    parse: "ip-blocklist",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "c2",
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus",
    file: "urlhaus.csv",
    parse: "urlhaus-csv",
    entityType: "URL",
    hitType: "deterministic_ioc",
    classification: "malware_url",
  },
  {
    sourcePolicyId: "abuse.ch/urlhaus-payloads",
    file: "urlhaus-payloads.csv",
    parse: "urlhaus-payloads-csv",
    entityType: "HASH",
    hitType: "deterministic_ioc",
    classification: "malware_payload",
  },
  {
    sourcePolicyId: "spamhaus/drop",
    file: "spamhaus-drop.txt",
    parse: "spamhaus-drop",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "drop",
  },
  {
    sourcePolicyId: "spamhaus/edrop",
    file: "spamhaus-edrop.txt",
    parse: "spamhaus-drop",
    entityType: "IP",
    hitType: "deterministic_ioc",
    classification: "edrop",
  },
];

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
