// RFC 0005 — CVE core-source barrel (#611).
//
// Importing this module runs each per-source file's `registerCveSource(...)`
// side effect, populating the registry before any consumer reads it. The
// ingestion engine (`../cve-fetch.ts`) and the enumeration accessor's consumers
// import this barrel so registration is guaranteed to have run.
//
// Adding a CVE source is exactly: create `./<source>.ts` with its descriptor,
// append ONE import line below, and (for a NEW closed-union member) extend
// `CveSourceId` / `ALL_CVE_SOURCES` / `CVE_SOURCE_LABELS` in `../catalog.ts`
// (#602). The list here is append-only — no structured array is edited — so
// parallel source issues do not conflict.

import "./nvd";
import "./kev";
import "./epss";

export {
  allCveSourceDescriptors,
  type CveFetchConfig,
  type CveParseResult,
  type CveSnapshotInsertRow,
  type CveSourceDescriptor,
  getCveSourceDescriptor,
  registerCveSource,
  unregisterCveSource,
} from "./registry";
