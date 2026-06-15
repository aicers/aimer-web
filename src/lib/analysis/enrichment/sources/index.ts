// RFC 0003 — TI IOC-feed source barrel (#588).
//
// Importing this module runs every per-source file's `registerTiSource(...)`
// side effect, populating the central registry before any derived structure
// (policy list / catalog / fixture map) reads it. Consumers that read the
// registry (`local-feed-enricher`, `feed-catalog`, `fixture-feeds`) import this
// barrel so registration is guaranteed to have run.
//
// Adding a source is exactly: create `./<source>.ts` with its descriptor, then
// append ONE import line below. The list is append-only — no structured array
// is edited — so parallel source issues do not conflict here.

import "./abuse-ch-feodo";
import "./abuse-ch-urlhaus";
import "./abuse-ch-urlhaus-payloads";
import "./botvrij";
import "./cert-pl";
import "./eset";
import "./infoblox";
import "./misp-warninglists";
import "./phishing-database";
import "./prodaft";
import "./spamhaus-drop";
import "./spamhaus-edrop";
import "./unit42";
import "./volexity";

export {
  allTiSourceDescriptors,
  FEED_MAX_AGE_MS,
  FETCH_AUTH_KEY_PLACEHOLDER,
  getTiSourceDescriptor,
  registerTiSource,
  type TiSourceDescriptor,
  type TiSourceFetchConfig,
  unregisterTiSource,
} from "./registry";
