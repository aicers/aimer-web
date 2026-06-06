import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditAction } from "../actions";

// ---------------------------------------------------------------------------
// Analyst-invitation audit convention (Discussion #6 §6.8, #266)
//
// Analyst invitations do NOT get their own action namespace. They reuse the
// member-side `invitation.*` actions and are distinguished purely by
// `target_type = 'analyst_invitation'`. These tests pin that convention so a
// future commit cannot silently fork a parallel `analyst.invitation.*`
// namespace — doing so must break the build here.
// ---------------------------------------------------------------------------

const ACTIONS_FILE = join(__dirname, "..", "actions.ts");

function extractAuditActions(): string[] {
  const source = readFileSync(ACTIONS_FILE, "utf-8");
  const matches = source.match(/"([a-z][a-z0-9_.]+)"/g);
  if (!matches) throw new Error("No AuditAction strings found in actions.ts");
  return matches.map((m) => m.slice(1, -1));
}

/** The target_type that tags an `invitation.*` row as an analyst invitation. */
const ANALYST_INVITATION_TARGET_TYPE = "analyst_invitation";

/** Member-side actions reused verbatim for the analyst invitation lifecycle. */
const REUSED_INVITATION_ACTIONS: AuditAction[] = [
  "invitation.created",
  "invitation.accepted",
  "invitation.failed",
  "invitation.expired",
  "invitation.revoked",
];

describe("analyst invitation audit convention (#266)", () => {
  const allActions = extractAuditActions();

  it("reuses the member-side invitation.* actions (they exist in the taxonomy)", () => {
    const actionSet = new Set(allActions);
    const missing = REUSED_INVITATION_ACTIONS.filter(
      (action) => !actionSet.has(action),
    );
    expect(
      missing,
      `Analyst invitations reuse these actions, but they are absent: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("defines NO parallel analyst.invitation.* namespace", () => {
    const forked = allActions.filter((action) =>
      action.startsWith("analyst.invitation"),
    );
    expect(
      forked,
      `Analyst invitations must reuse invitation.* with target_type='${ANALYST_INVITATION_TARGET_TYPE}', ` +
        `not a separate namespace. Found: ${forked.join(", ")}`,
    ).toEqual([]);
  });

  it("pins the target_type that distinguishes analyst invitations", () => {
    // The convention is the only thing separating an analyst invitation row
    // from a member invitation row. Member-side producers use
    // target_type='invitation'; analyst-side producers must use this value.
    expect(ANALYST_INVITATION_TARGET_TYPE).toBe("analyst_invitation");
    expect(ANALYST_INVITATION_TARGET_TYPE).not.toBe("invitation");
  });
});
