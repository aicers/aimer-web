// RFC 0003 P1a (#361) — load the committed, pinned Tier-1 feed fixtures
// and seed them into `ioc_feed_snapshot`.
//
// These fixtures (`./feeds/*`) are the offline stand-in for live feed
// downloads (RFC 0003 §"Testing" — "fixtures are pinned local snapshots,
// never live feeds"). Tests and local dev seed from them; the scheduled
// refresh worker that fetches the real feeds is a separate follow-up.
//
// Reads the fixture files from disk relative to the repo root. This is a
// test/dev-only seeding path — production imports come from the (future)
// refresh worker, never this module.

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  type FeedSnapshotRow,
  importFeedSnapshot,
  normalizeCidrs,
  normalizeExactValues,
  parseIpBlocklist,
  parseSpamhausDrop,
  parseUrlhausCsv,
  parseUrlhausHosts,
} from "./feed-import";
import type { EntityType, HitType } from "./types";

const FEEDS_DIR = join(
  process.cwd(),
  "src",
  "lib",
  "analysis",
  "enrichment",
  "feeds",
);

type ParseKind = "ip-blocklist" | "urlhaus-csv" | "spamhaus-drop";

interface FixtureFeedSpec {
  sourcePolicyId: string;
  file: string;
  parse: ParseKind;
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

/** Parse + normalize one fixture spec into snapshot rows. */
export function loadFixtureRows(spec: FixtureFeedSpec): FeedSnapshotRow[] {
  const text = readFileSync(join(FEEDS_DIR, spec.file), "utf8");
  switch (spec.parse) {
    case "ip-blocklist":
      return normalizeExactValues(spec.entityType, parseIpBlocklist(text)).rows;
    case "urlhaus-csv": {
      // URLhaus contributes both URL rows and the DOMAIN host of each URL,
      // under the one `abuse.ch/urlhaus` source, so a bare `host`/`dns_query`
      // domain member matches the same infrastructure (its policy already
      // declares `["URL", "DOMAIN"]`).
      const urls = parseUrlhausCsv(text);
      const urlRows = normalizeExactValues("URL", urls).rows;
      const domainRows = normalizeExactValues(
        "DOMAIN",
        parseUrlhausHosts(urls),
      ).rows.map((row) => ({ ...row, entityType: "DOMAIN" as EntityType }));
      return [...urlRows, ...domainRows];
    }
    case "spamhaus-drop":
      return normalizeCidrs(parseSpamhausDrop(text)).rows;
    default:
      throw new Error(`unknown parse kind: ${spec.parse}`);
  }
}

/**
 * Seed every fixture feed into `ioc_feed_snapshot` (replace-all per
 * source). `sourceUpdatedAt` stamps the snapshot freshness — pass a value
 * relative to the test clock to control fresh vs stale coverage.
 */
export async function seedFixtureFeeds(
  pool: Pool,
  options: { sourceUpdatedAt: string; sourceVersion?: string },
): Promise<void> {
  for (const spec of FIXTURE_FEEDS) {
    await importFeedSnapshot(pool, {
      sourcePolicyId: spec.sourcePolicyId,
      entityType: spec.entityType,
      hitType: spec.hitType,
      classification: spec.classification,
      sourceVersion: options.sourceVersion,
      sourceUpdatedAt: options.sourceUpdatedAt,
      rows: loadFixtureRows(spec),
    });
  }
}
