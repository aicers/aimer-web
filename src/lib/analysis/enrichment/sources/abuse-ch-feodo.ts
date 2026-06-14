// abuse.ch Feodo Tracker — botnet C2 IP blocklist (RFC 0003 Tier-1).
//
// Self-registers its `TiSourceDescriptor`; the policy list, catalog spec,
// self-fetch config, and fixture map are all derived from it. Self-fetch uses
// the recommended *plain-text* IP blocklist (the `ip-blocklist` parser), NOT
// the JSON/full-IOC variant, generated every 5 min — floor 5 min.

import { FEED_MAX_AGE_MS, FIVE_MINUTES_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "abuse.ch/feodo",
  label: "abuse.ch Feodo Tracker",
  entityTypes: ["IP"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "ip-blocklist",
  entityType: "IP",
  hitType: "deterministic_ioc",
  classification: "c2",
  fetch: {
    urls: [
      "https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt",
    ],
    cadenceFloorMs: FIVE_MINUTES_MS,
    parse: "ip-blocklist",
  },
  fixtureFile: "feodo-ipblocklist.txt",
});
