// Botvrij.eu — general IOC lists (IP / domain / URL / hash) (RFC 0003 Tier-1).
//
// RFC 0003 Appendix A vetted Botvrij.eu as USE-OK-DIRECT (no-resale only, which
// does not bar first-party internal use). It publishes plain per-type lists
// under `https://www.botvrij.eu/data/`; this file registers one descriptor per
// entity type, each parsed by the generic-list parser (#593) — no bespoke code.
//
// Critically, these fetch the `.raw` endpoints, NOT the default `ioclist.<type>`
// files. The default files carry a `#` header AND an inline trailing comment on
// every data line (`<ioc> # <annotation>`); `parseGenericList` pushes the whole
// trimmed line and only drops lines that *start* with a comment prefix, so the
// annotated files would yield `<ioc> # …` rows that fail normalization (zero
// usable rows). The `.raw` variants are bare — one plain (not defanged)
// indicator per line — so `refang` stays off.
//
// An entity type spread across several `.raw` files (IP = ip-dst + ip-src;
// DOMAIN = domain + hostname; HASH = md5 + sha1 + sha256) collapses into one
// descriptor: `fetch.urls` are fetched in order and concatenated before a
// single parse. HASH mixes MD5/SHA1/SHA256, distinguished by digest length at
// import. Botvrij refreshes irregularly (on new writeups, not a fixed
// schedule), so a conservative 1 h cadence floor is ample — no need for the
// 5-min floor the abuse.ch feeds use. `floorEligible: false` pending OQ9.

import {
  FEED_MAX_AGE_MS,
  ONE_HOUR_MS,
  registerTiSource,
  type TiSourceDescriptor,
} from "./registry";

const DATA_BASE = "https://www.botvrij.eu/data";

/** Shared descriptor shape for every Botvrij entity-type list. */
function botvrijSource(
  spec: Pick<
    TiSourceDescriptor,
    "sourcePolicyId" | "label" | "entityType" | "fixtureFile"
  > & { rawFiles: readonly string[] },
): TiSourceDescriptor {
  const urls = spec.rawFiles.map((file) => `${DATA_BASE}/${file}`);
  return {
    sourcePolicyId: spec.sourcePolicyId,
    label: spec.label,
    entityTypes: [spec.entityType],
    deterministicCoverage: true,
    maxAge: FEED_MAX_AGE_MS,
    floorEligible: false,
    parse: "generic-list",
    parseConfig: { kind: "generic-list" },
    entityType: spec.entityType,
    hitType: "deterministic_ioc",
    classification: "misc",
    fetch: {
      urls,
      cadenceFloorMs: ONE_HOUR_MS,
      parse: "generic-list",
      parseConfig: { kind: "generic-list" },
    },
    fixtureFile: spec.fixtureFile,
  };
}

registerTiSource(
  botvrijSource({
    sourcePolicyId: "botvrij/ip",
    label: "Botvrij.eu (IP)",
    entityType: "IP",
    rawFiles: ["ioclist.ip-dst.raw", "ioclist.ip-src.raw"],
    fixtureFile: "botvrij-ip.txt",
  }),
);

registerTiSource(
  botvrijSource({
    sourcePolicyId: "botvrij/domain",
    label: "Botvrij.eu (domain)",
    entityType: "DOMAIN",
    rawFiles: ["ioclist.domain.raw", "ioclist.hostname.raw"],
    fixtureFile: "botvrij-domain.txt",
  }),
);

registerTiSource(
  botvrijSource({
    sourcePolicyId: "botvrij/url",
    label: "Botvrij.eu (URL)",
    entityType: "URL",
    rawFiles: ["ioclist.url.raw"],
    fixtureFile: "botvrij-url.txt",
  }),
);

registerTiSource(
  botvrijSource({
    sourcePolicyId: "botvrij/hash",
    label: "Botvrij.eu (hash)",
    entityType: "HASH",
    rawFiles: ["ioclist.md5.raw", "ioclist.sha1.raw", "ioclist.sha256.raw"],
    fixtureFile: "botvrij-hash.txt",
  }),
);
