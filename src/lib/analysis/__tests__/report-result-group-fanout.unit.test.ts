// Display-time cross-member de-redaction fan-out (#525).
//
// A group report cites analyzed leaves that live in the MEMBER customer DBs,
// and the same `(aice_id, event_key)` (or `story_id`) can exist in more than
// one member DB. This isolates the loader's `buildReportTokenPlaintext` to
// prove the fan-out routes each cited ref to the OWNING member's pool by its
// `customer_id`, restores its report-scope token from THAT member's redaction
// map, and batches the redaction decrypt (one query per member pool). The
// OpenBao-backed decrypt is stubbed to return member-specific plaintext so a
// mis-route would surface as the wrong member's value.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Member-specific plaintext: the first arg is the owning member's customer id,
// so a ref routed to the wrong member's pool would decrypt to the other
// member's value and the assertions below would fail.
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: vi.fn(async (customerId: string) => ({
    "<<REDACTED_IP_001>>": {
      kind: "IP",
      value: customerId === "cust-A" ? "10.0.0.1" : "10.0.0.2",
    },
  })),
}));

const { __testables } = await import("../report-result-page-loader");
const { buildReportTokenPlaintext } = __testables;

// A per-member pg pool stub. Both members hold an event leaf for the SAME
// `(aice_id, event_key)` carrying the SAME event-scope source token, so only
// the member routing — not the key — can disambiguate them.
function makeMemberPool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM event_analysis_result")) {
        return {
          rows: [
            {
              analysis_text: "Event narrative <<REDACTED_IP_001>>.",
              severity_factors: [],
              likelihood_factors: [],
              priority_tier: "HIGH",
              severity_score: 0.9,
              likelihood_score: 0.9,
              ttp_tags: [],
              superseded_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM event_redaction_map")) {
        return {
          rows: [
            {
              aice_id: "aice-1",
              event_key: "9001",
              ciphertext: Buffer.from("ct"),
              wrapped_dek: "dek",
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
}

describe("buildReportTokenPlaintext — cross-member fan-out (#525)", () => {
  it("routes a same-(aice_id, event_key) ref to the owning member's plaintext", async () => {
    const poolA = makeMemberPool();
    const poolB = makeMemberPool();
    const poolFor = (cid: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: pool stub
      (cid === "cust-A" ? poolA : poolB) as any;

    const result = await buildReportTokenPlaintext(
      poolFor,
      // The group subject id — distinct from either member, so a ref WITHOUT a
      // customer_id would degrade here and (correctly) find no member pool.
      "group-1",
      [],
      [
        // Two cited event leaves with the IDENTICAL (aice_id, event_key) but
        // different owning members — the whole point of #523's `customer_id`.
        {
          aice_id: "aice-1",
          event_key: "9001",
          generation: 1,
          customer_id: "cust-A",
        },
        {
          aice_id: "aice-1",
          event_key: "9001",
          generation: 1,
          customer_id: "cust-B",
        },
      ],
      [],
      { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
    );

    // Leaf 1 (cust-A) → report token R1; leaf 2 (cust-B) → R2. Each restores
    // from its OWN member's redaction map, not the other's.
    const map = result.plaintextByReportToken;
    expect(map.get("<<REDACTED_IP_R1_001>>")).toBe("10.0.0.1");
    expect(map.get("<<REDACTED_IP_R2_001>>")).toBe("10.0.0.2");

    // Each member pool is queried for its redaction map exactly once (batched,
    // no per-ref N+1).
    const redactionCalls = (pool: ReturnType<typeof makeMemberPool>) =>
      pool.query.mock.calls.filter((c) =>
        String(c[0]).includes("FROM event_redaction_map"),
      ).length;
    expect(redactionCalls(poolA)).toBe(1);
    expect(redactionCalls(poolB)).toBe(1);
  });

  it("routes a same-story_id ref to the owning member's member-event map", async () => {
    // Both members hold story 5001 with one member event carrying an IP source
    // token; only the story ref's customer_id selects which member's redaction
    // map (and member-event lookup) is used.
    const makeStoryPool = () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM story_analysis_result")) {
          return {
            rows: [
              {
                analysis_text: "Story narrative <<REDACTED_IP_E1_001>>.",
                severity_factors: [],
                likelihood_factors: [],
                input_event_refs: [
                  { index: 1, aiceId: "aice-9", eventKey: "5500" },
                ],
                priority_tier: "HIGH",
                severity_score: 0.8,
                likelihood_score: 0.8,
                ttp_tags: [],
                superseded_at: null,
              },
            ],
          };
        }
        if (sql.includes("FROM event_redaction_map")) {
          return {
            rows: [
              {
                aice_id: "aice-9",
                event_key: "5500",
                ciphertext: Buffer.from("ct"),
                wrapped_dek: "dek",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    });
    const poolA = makeStoryPool();
    const poolB = makeStoryPool();
    const poolFor = (cid: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: pool stub
      (cid === "cust-A" ? poolA : poolB) as any;

    const result = await buildReportTokenPlaintext(
      poolFor,
      "group-1",
      [
        { story_id: "5001", generation: 1, customer_id: "cust-A" },
        { story_id: "5001", generation: 1, customer_id: "cust-B" },
      ],
      [],
      [],
      { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
    );

    // Both members' distinct plaintexts appear — a mis-route would yield the
    // same value twice (one member's map serving both stories).
    const values = [...result.plaintextByReportToken.values()];
    expect(values).toContain("10.0.0.1");
    expect(values).toContain("10.0.0.2");
  });

  it("degrades a ref whose customer_id names no known member", async () => {
    const poolA = makeMemberPool();
    const poolFor = (cid: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: pool stub
      cid === "cust-A" ? (poolA as any) : undefined;

    const result = await buildReportTokenPlaintext(
      poolFor,
      "group-1",
      [],
      [
        {
          aice_id: "aice-1",
          event_key: "9001",
          generation: 1,
          customer_id: "cust-missing",
        },
      ],
      [],
      { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
    );
    // No pool for the named member → token stays unrestored (tokenized), never
    // throws and never leaks another member's plaintext.
    expect(result.plaintextByReportToken.size).toBe(0);
    expect(poolA.query).not.toHaveBeenCalled();
  });
});
