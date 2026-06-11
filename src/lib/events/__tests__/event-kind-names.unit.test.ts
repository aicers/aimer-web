// #552 — friendly kind-name resolution. The map is a verbatim port of
// aice-web-next's `EVENT_KIND_FRIENDLY_NAMES`; resolution maps a stored raw
// `__typename` to its friendly name and falls back to the raw value.

import { describe, expect, it } from "vitest";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  eventKindDisplayName,
} from "../event-kind-names";

describe("eventKindDisplayName (#552)", () => {
  it("maps a curated kind to its friendly name (matching aice-web-next)", () => {
    expect(eventKindDisplayName("HttpThreat")).toBe("HTTP Threat");
    expect(eventKindDisplayName("BlocklistHttp")).toBe("Blocklist HTTP");
  });

  it("falls back to the raw kind for a value absent from the map", () => {
    expect(eventKindDisplayName("SomeNewKind")).toBe("SomeNewKind");
  });

  it("returns null for a null kind (caller renders time only)", () => {
    expect(eventKindDisplayName(null)).toBeNull();
  });

  it("exposes the friendly-name map for the report/list surfaces", () => {
    // Spot-check a few well-known entries to guard against accidental drift.
    expect(EVENT_KIND_FRIENDLY_NAMES.ExternalDdos).toBe("External DDoS");
    expect(EVENT_KIND_FRIENDLY_NAMES.MultiHostPortScan).toBe(
      "Multi-Host Port Scan",
    );
  });
});
