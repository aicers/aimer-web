// CERT Polska Warning List — active phishing domains, PL-centric, best-effort
// (RFC 0003 Tier-1, Appendix A: USE-OK-DIRECT).
//
// CERT Polska's v2 warning list publishes a plain-text domains list at
// `https://hole.cert.pl/domains/v2/domains.txt` ("active domains only, one
// domain per line"), so the source parses with the parameterized `generic-list`
// parser (#593) — no bespoke parser. It is a *positive* known-bad feed (active
// phishing domains): despite the "warning list" wording and the
// `cert-pl/warninglist` id, it is NOT the negative warninglist class (public
// resolvers / CDNs / bogons) added in #599 — so `polarity` is omitted (positive
// default), `deterministicCoverage` stays `true`, and it declares
// `hitType: "deterministic_ioc"`. `floorEligible` is `false` pending OQ9.
//
// LICENCE GATE (RFC 0003 OQ9). The data grant ("may be accessed, used and
// processed without obtaining special permission or license") lives only in the
// archived `CERT-Polska/phishing-api` spec; the current v2 endpoints carry no
// licence text. Self-fetch *is* the "accessing / processing" act the grant
// governs, so the live `fetch` block lands ONLY once the grant is re-confirmed.
// That re-confirmation is not in hand, so this ships fixture-only: the
// descriptor + synthetic fixture access no CERT Polska data, so the licence
// question does not bite. `selfFetchUnavailable` is omitted (not `"merged"`), so
// the admin self-fetch table renders the correct "Fixture only" badge.
//
// fetch: pending OQ9 grant re-confirm — add once re-confirmed. The
// `cadenceFloorMs` is deliberately NOT chosen here; pick it in the live-fetch
// follow-up (the CERT page recommends a 5-min refresh, while a 1-h courtesy
// floor — `ONE_HOUR_MS`, imported there — is also acceptable):
//   fetch: {
//     urls: ["https://hole.cert.pl/domains/v2/domains.txt"],
//     cadenceFloorMs: /* choose at follow-up */,
//     parse: "generic-list",
//     parseConfig: { kind: "generic-list" },
//   }

import { FEED_MAX_AGE_MS, registerTiSource } from "./registry";

registerTiSource({
  sourcePolicyId: "cert-pl/warninglist",
  label: "CERT Polska Warning List",
  entityTypes: ["DOMAIN"],
  deterministicCoverage: true,
  maxAge: FEED_MAX_AGE_MS,
  floorEligible: false,
  parse: "generic-list",
  parseConfig: { kind: "generic-list" },
  entityType: "DOMAIN",
  hitType: "deterministic_ioc",
  classification: "phishing",
  fixtureFile: "cert-pl-warninglist.txt",
});
