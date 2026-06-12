// RFC 0003 self-fetch (3a, #568) — unit tests for the self-fetch engine's
// pure helpers (no live network, no DB):
//   - conditional-GET headers from fetch state,
//   - the hard cadence-floor guard,
//   - URLhaus Auth-Key URL-path substitution,
//   - the Spamhaus NDJSON parser (incl. metadata-line skip),
//   - the Auth-Key encrypt→decrypt round trip (Transit mocked).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock OpenBao Transit so envelope encryption runs locally (real AES-256-GCM
// under a fixed DEK). No network, no OpenBao.
const FIXED_DEK = Buffer.alloc(32, 7);
vi.mock("@/lib/crypto/transit", () => ({
  getTransitConfig: () => ({ addr: "http://bao.test", token: "t" }),
  generateDataKey: vi.fn(async () => ({
    plaintext: Buffer.from(FIXED_DEK),
    wrappedDek: "wrapped-v1",
  })),
  decryptDataKey: vi.fn(async () => Buffer.from(FIXED_DEK)),
}));

import {
  conditionalGetHeaders,
  type FeedFetchState,
  feedFetchLockKey,
  nextFetchAllowedAt,
  readFeedSourceAuthKey,
  resolveFetchUrls,
  SelfFetchError,
  setFeedSourceSecret,
  withinCadenceFloor,
} from "../feed-fetch";
import { parseFeedContent, parseSpamhausDropNdjson } from "../feed-import";

const FIVE_MIN = 5 * 60 * 1000;

function state(over: Partial<FeedFetchState> = {}): FeedFetchState {
  return {
    sourcePolicyId: "abuse.ch/feodo",
    lastFetchedAt: null,
    lastAttemptAt: null,
    etag: null,
    lastModified: null,
    lastStatus: null,
    lastError: null,
    lastRowCount: null,
    ...over,
  };
}

describe("conditionalGetHeaders", () => {
  it("is empty without stored validators", () => {
    expect(conditionalGetHeaders(null)).toEqual({});
    expect(conditionalGetHeaders(state())).toEqual({});
  });

  it("sends If-None-Match from the stored ETag", () => {
    expect(conditionalGetHeaders(state({ etag: '"abc"' }))).toEqual({
      "If-None-Match": '"abc"',
    });
  });

  it("sends If-Modified-Since from the stored Last-Modified", () => {
    expect(
      conditionalGetHeaders(
        state({ lastModified: "Wed, 21 Oct 2025 07:28:00 GMT" }),
      ),
    ).toEqual({ "If-Modified-Since": "Wed, 21 Oct 2025 07:28:00 GMT" });
  });

  it("sends both when both are known", () => {
    const headers = conditionalGetHeaders(
      state({ etag: '"e"', lastModified: "lm" }),
    );
    expect(headers).toEqual({
      "If-None-Match": '"e"',
      "If-Modified-Since": "lm",
    });
  });
});

describe("cadence floor", () => {
  it("allows the first-ever fetch (no prior fetch time)", () => {
    expect(nextFetchAllowedAt(null, FIVE_MIN)).toBeNull();
    expect(withinCadenceFloor(null, FIVE_MIN, new Date())).toBe(false);
  });

  it("blocks a fetch within the floor of the last fetch", () => {
    const last = "2026-06-12T00:00:00.000Z";
    const now = new Date("2026-06-12T00:02:00.000Z"); // +2 min < 5 min
    expect(
      withinCadenceFloor(state({ lastFetchedAt: last }), FIVE_MIN, now),
    ).toBe(true);
  });

  it("allows a fetch once the floor has elapsed", () => {
    const last = "2026-06-12T00:00:00.000Z";
    const now = new Date("2026-06-12T00:05:01.000Z"); // +5m1s > 5 min
    expect(
      withinCadenceFloor(state({ lastFetchedAt: last }), FIVE_MIN, now),
    ).toBe(false);
    expect(
      nextFetchAllowedAt(
        state({ lastFetchedAt: last }),
        FIVE_MIN,
      )?.toISOString(),
    ).toBe("2026-06-12T00:05:00.000Z");
  });
});

describe("resolveFetchUrls (URLhaus Auth-Key path substitution)", () => {
  const config = {
    urls: [
      "https://urlhaus-api.abuse.ch/v2/urls/exports/{AUTH_KEY}/recent.csv",
    ],
    cadenceFloorMs: FIVE_MIN,
    parse: "urlhaus-csv" as const,
    authKeyName: "urlhaus",
  };

  it("substitutes the Auth-Key into the URL path", () => {
    expect(resolveFetchUrls(config, "secret-key")).toEqual([
      "https://urlhaus-api.abuse.ch/v2/urls/exports/secret-key/recent.csv",
    ]);
  });

  it("url-encodes the Auth-Key", () => {
    expect(resolveFetchUrls(config, "a/b c")).toEqual([
      "https://urlhaus-api.abuse.ch/v2/urls/exports/a%2Fb%20c/recent.csv",
    ]);
  });

  it("throws when an Auth-Key is required but missing", () => {
    expect(() => resolveFetchUrls(config, null)).toThrow(SelfFetchError);
  });

  it("leaves URLs without the placeholder untouched (no key needed)", () => {
    const noKey = {
      urls: [
        "https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt",
      ],
      cadenceFloorMs: FIVE_MIN,
      parse: "ip-blocklist" as const,
    };
    expect(resolveFetchUrls(noKey, null)).toEqual(noKey.urls);
  });
});

describe("parseSpamhausDropNdjson", () => {
  const ndjson = [
    '{"type":"metadata","timestamp":1718150400,"size":2}',
    '{"cidr":"1.2.3.0/24","sblid":"SBL1","rir":"arin"}',
    "; a stray comment line",
    "",
    '{"cidr":"2001:db8::/32","sblid":"SBL2","rir":"ripencc"}',
    '{"sblid":"SBL3"}', // object without a cidr → skipped
    "not even json",
  ].join("\n");

  it("extracts cidr from object lines and skips metadata/comments/garbage", () => {
    expect(parseSpamhausDropNdjson(ndjson)).toEqual([
      "1.2.3.0/24",
      "2001:db8::/32",
    ]);
  });

  it("normalizes via parseFeedContent('spamhaus-drop-ndjson')", () => {
    const rows = parseFeedContent("spamhaus-drop-ndjson", "IP", ndjson);
    expect(rows.map((r) => r.cidr)).toEqual(["1.2.3.0/24", "2001:db8::/32"]);
  });
});

describe("feedFetchLockKey", () => {
  it("is stable and positive per source, and differs across sources", () => {
    const a = feedFetchLockKey("abuse.ch/feodo");
    const b = feedFetchLockKey("spamhaus/drop");
    expect(a).toBe(feedFetchLockKey("abuse.ch/feodo"));
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("Auth-Key secret store round trip (Transit mocked)", () => {
  // A tiny in-memory stand-in for the feed pool: captures the upserted row
  // and serves it back, so the encrypt→store→read→decrypt path is exercised
  // end-to-end without a database.
  let stored: { wrapped_dek: string; ciphertext: Buffer } | null;
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO feed_source_secret/.test(sql)) {
        stored = {
          wrapped_dek: params[1] as string,
          ciphertext: params[2] as Buffer,
        };
        return { rows: [] };
      }
      if (/SELECT wrapped_dek, ciphertext/.test(sql)) {
        return { rows: stored ? [stored] : [] };
      }
      return { rows: [] };
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal pool stand-in for the test
  } as any;

  beforeEach(() => {
    stored = null;
    pool.query.mockClear();
  });

  it("encrypts on write and decrypts back the same plaintext", async () => {
    await setFeedSourceSecret(pool, "urlhaus", "my-auth-key-123");
    // Ciphertext must NOT contain the plaintext.
    expect(stored?.ciphertext.toString("utf8")).not.toContain("my-auth-key");
    const back = await readFeedSourceAuthKey(pool, "urlhaus");
    expect(back).toBe("my-auth-key-123");
  });

  it("returns null when the secret is unset", async () => {
    expect(await readFeedSourceAuthKey(pool, "urlhaus")).toBeNull();
  });
});
