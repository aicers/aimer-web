import { describe, expect, it } from "vitest";

import {
  buildRedactionMapCascadeDelete,
  redactionMapReferentNotExistsClauses,
} from "../cascade";

describe("redactionMapReferentNotExistsClauses", () => {
  it("emits five clauses covering every (aice_id, event_key) referent table", () => {
    const clauses = redactionMapReferentNotExistsClauses("m");
    expect(clauses).toHaveLength(5);
    const joined = clauses.join("\n");
    // The four redacted-referent tables.
    expect(joined).toMatch(/FROM detection_events/);
    expect(joined).toMatch(/FROM baseline_event/);
    expect(joined).toMatch(/FROM story_member sm/);
    expect(joined).toMatch(/FROM policy_event pe/);
    // Plus event_analysis_result.
    expect(joined).toMatch(/FROM event_analysis_result/);
    // story and policy_run are sweep targets but not direct referent
    // inputs — they're only joined through their children.
    expect(joined).not.toMatch(/NOT EXISTS \([^)]*FROM story\b/);
    expect(joined).not.toMatch(/NOT EXISTS \([^)]*FROM policy_run\b/);
    // Phase 2 column names: baseline_event uses source_aice_id,
    // story uses source_aice_id, policy_run uses source_aice_id, and
    // policy_event joins through policy_run.run_id (not policy_run.id).
    expect(joined).toMatch(/source_aice_id\s*=\s*m\.aice_id/);
    expect(joined).toMatch(/pr\.run_id\s*=\s*pe\.run_id/);
    expect(joined).not.toMatch(/pr\.id\b/);
  });

  it("interpolates the supplied alias into every clause", () => {
    const clauses = redactionMapReferentNotExistsClauses("foo");
    for (const clause of clauses) {
      expect(clause).toContain("foo.aice_id");
      expect(clause).toContain("foo.event_key");
    }
  });
});

describe("buildRedactionMapCascadeDelete", () => {
  it("wraps the candidate selection in a CTE that locks rows in PK order", () => {
    const sql = buildRedactionMapCascadeDelete();
    expect(sql).toContain("WITH candidates AS");
    expect(sql).toContain("FROM event_redaction_map m");
    expect(sql).toContain("ORDER BY aice_id, event_key");
    expect(sql).toContain("FOR UPDATE OF m");
    expect(sql).toContain("DELETE FROM event_redaction_map m");
    expect(sql).toContain("USING candidates c");
    expect(sql).toMatch(
      /WHERE m\.aice_id = c\.aice_id AND m\.event_key = c\.event_key/,
    );
  });
});
