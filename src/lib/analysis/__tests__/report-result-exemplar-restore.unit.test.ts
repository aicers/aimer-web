// Display-path restoration of long-tail exemplar tokens (#495).
//
// The acceptance criteria require that the display loader restore exemplar
// `<<REDACTED_*_R{j}_*>>` tokens to plaintext (no raw token in the UI), and
// that exemplar leaves are ALWAYS replayed at the English canonical language
// regardless of the row's `lang`. The native-pinned / translate token round
// trips are covered by `report-long-tail.db.test.ts`; this isolates the
// loader's `buildReportTokenPlaintext` so the new exemplar branch — the
// English-pinned leaf fetch, the combined `R{j}` numbering, the
// `index − stories − events − 1` slice into `exemplarRefs`, and the union of
// the exemplar token map into the cited one — is exercised directly, with the
// OpenBao-backed decrypt stubbed.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub only the redaction decrypt seam — the rest of the rewrite/replay runs
// for real so the `R{j}` numbering must line up with the builder's.
vi.mock("@/lib/redaction", () => ({
  decryptRedactionMap: vi.fn(async () => ({
    // The event-scope source token the seeded exemplar factor carries.
    "<<REDACTED_EMAIL_001>>": { kind: "EMAIL", value: "alice@corp.example" },
  })),
}));

const { __testables } = await import("../report-result-page-loader");
const { buildReportTokenPlaintext } = __testables;

// A pg pool stub routed by SQL fragment. Records the params each leaf SELECT
// was called with so the test can assert the language pin.
function makePool(captured: {
  citedEventLang?: string;
  exemplarLang?: string;
}) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: pg query minimal surface
    query: vi.fn(async (sql: string, params?: any[]) => {
      // Cited event leaf fetch (carries ttp_tags / priority_tier).
      if (
        sql.includes("FROM event_analysis_result") &&
        sql.includes("ttp_tags")
      ) {
        // Batched event read (#525): params are `[lang, ...tuples]`, so the
        // pinned language is the first bind, not `$4`.
        captured.citedEventLang = params?.[0];
        return {
          rows: [
            {
              analysis_text: "Cited event <<REDACTED_EMAIL_001>>.",
              severity_factors: [],
              likelihood_factors: [],
              priority_tier: "HIGH",
              severity_score: 0.9,
              likelihood_score: 0.9,
              ttp_tags: ["T1"],
              superseded_at: null,
              aice_id: "aice-c",
              event_key: "6001",
              generation: 1,
              model_name: "openai",
              model: "gpt-4o",
            },
          ],
        };
      }
      // Exemplar leaf fetch (selects only the factor arrays, no ttp_tags).
      if (
        sql.includes("FROM event_analysis_result") &&
        sql.includes("severity_factors, likelihood_factors") &&
        !sql.includes("ttp_tags")
      ) {
        // Batched exemplar read (#525): the English-canonical `lang` is the
        // first bind, not `$4`.
        captured.exemplarLang = params?.[0];
        return {
          rows: [
            {
              severity_factors: ["long tail <<REDACTED_EMAIL_001>>"],
              likelihood_factors: [],
              aice_id: "aice-x",
              event_key: "6002",
              generation: 1,
              model_name: "openai",
              model: "gpt-4o",
            },
          ],
        };
      }
      // Redaction-map decrypt source rows — one per cited/exemplar leaf key.
      if (sql.includes("FROM event_redaction_map")) {
        return {
          rows: [
            {
              aice_id: "aice-c",
              event_key: "6001",
              ciphertext: Buffer.from("ct"),
              wrapped_dek: "dek",
            },
            {
              aice_id: "aice-x",
              event_key: "6002",
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

describe("buildReportTokenPlaintext — exemplar restoration (#495)", () => {
  it("restores an exemplar R{j} token to plaintext and pins the leaf to English", async () => {
    const captured: { citedEventLang?: string; exemplarLang?: string } = {};
    const pool = makePool(captured);

    const result = await buildReportTokenPlaintext(
      // biome-ignore lint/suspicious/noExplicitAny: pool stub
      () => pool as any,
      "cust-1",
      [],
      // One cited event leaf → report token R1.
      [{ aice_id: "aice-c", event_key: "6001", generation: 1 }],
      // One exemplar leaf (distinct event) → appended after, report token R2.
      [
        {
          aice_id: "aice-x",
          event_key: "6002",
          generation: 1,
          model_name: "openai",
          model: "gpt-4o",
        },
      ],
      // The ROW is Korean; the exemplar must still be fetched at English.
      { lang: "KOREAN", modelName: "openai", model: "gpt-4o" },
    );

    // Cited event replays at the row language; the exemplar replays at the
    // English canonical, independent of the row's `lang` (#495).
    expect(captured.citedEventLang).toBe("KOREAN");
    expect(captured.exemplarLang).toBe("ENGLISH");

    // The exemplar leaf is the second combined leaf, so its factor token is
    // numbered R2 — and it resolves to the decrypted plaintext, not a raw
    // `<<REDACTED_*_R{j}_*>>`.
    const map = result.plaintextByReportToken;
    expect(map.get("<<REDACTED_EMAIL_R2_001>>")).toBe("alice@corp.example");
    // The cited event token (R1) restores through the same union.
    expect(map.get("<<REDACTED_EMAIL_R1_001>>")).toBe("alice@corp.example");
  });

  it("short-circuits with no refs at all", async () => {
    const captured: { citedEventLang?: string; exemplarLang?: string } = {};
    const pool = makePool(captured);
    const result = await buildReportTokenPlaintext(
      // biome-ignore lint/suspicious/noExplicitAny: pool stub
      () => pool as any,
      "cust-1",
      [],
      [],
      [],
      { lang: "ENGLISH", modelName: "openai", model: "gpt-4o" },
    );
    expect(result.plaintextByReportToken.size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
