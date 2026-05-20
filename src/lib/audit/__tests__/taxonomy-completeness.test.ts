import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditAction } from "../actions";

// ---------------------------------------------------------------------------
// Extract all AuditAction string values from the source file
// ---------------------------------------------------------------------------

const ACTIONS_FILE = join(__dirname, "..", "actions.ts");

function extractAuditActions(): string[] {
  const source = readFileSync(ACTIONS_FILE, "utf-8");
  const matches = source.match(/"([a-z][a-z0-9_.]+)"/g);
  if (!matches) throw new Error("No AuditAction strings found in actions.ts");
  return matches.map((m) => m.slice(1, -1));
}

// ---------------------------------------------------------------------------
// Producer map — actions that have a verified emitter in production code.
// Guard-level audit (via withAuth `audit` option) counts as a producer.
// ---------------------------------------------------------------------------

const PRODUCED: Record<string, string> = {
  // General auth
  "general.auth.sign_in_success": "src/app/api/auth/callback/route.ts",
  "general.auth.sign_in_denied": "src/app/api/auth/callback/route.ts",
  "general.auth.sign_out": "src/app/api/auth/sign-out/route.ts",
  "general.auth.sign_out_all": "src/app/api/auth/sign-out-all/route.ts",
  // Admin auth
  "admin.auth.sign_in_success": "src/app/api/admin-auth/callback/route.ts",
  "admin.auth.sign_in_denied": "src/app/api/admin-auth/callback/route.ts",
  "admin.auth.sign_out": "src/app/api/admin-auth/sign-out/route.ts",
  "admin.auth.sign_out_all": "src/app/api/admin-auth/sign-out-all/route.ts",
  // Session
  "session.ip_mismatch": "src/lib/auth/guards.ts",
  "session.ua_mismatch": "src/lib/auth/guards.ts",
  "session.idle_timeout": "src/lib/auth/guards.ts",
  "session.absolute_timeout": "src/lib/auth/guards.ts",
  "session.revoked": "src/lib/auth/guards.ts",
  "session.cross_context_mismatch": "src/lib/auth/same-account.ts",
  // Bridge
  "bridge.connection_request": "src/app/api/auth/bridge/route.ts",
  "bridge.connection_granted": "src/app/api/auth/callback/route.ts",
  "bridge.connection_denied": "src/app/api/auth/callback/route.ts",
  "bridge.write_attempt_blocked": "src/app/api/events/ingest/route.ts",
  // Invitation (guard-level: created, revoked; handler-level: accepted, failed, expired)
  "invitation.created": "src/app/api/invitations/route.ts",
  "invitation.accepted": "src/app/api/auth/callback/route.ts",
  "invitation.failed": "src/app/api/auth/callback/route.ts",
  "invitation.expired": "src/app/api/auth/callback/route.ts",
  "invitation.revoked": "src/app/api/invitations/[id]/route.ts",
  // Membership (guard-level: role_changed, removed)
  "membership.role_changed": "src/app/api/members/[accountId]/route.ts",
  "membership.removed": "src/app/api/members/[accountId]/route.ts",
  // Customer (guard-level: created, deleted)
  "customer.created": "src/app/api/admin/customers/route.ts",
  "customer.deleted": "src/app/api/admin/customers/[customerId]/route.ts",
  // Customer redaction ranges + retention settings (guard-level)
  "customer_redaction_ranges.added":
    "src/app/api/admin/customers/[customerId]/redaction-ranges/route.ts",
  "customer_redaction_ranges.deleted":
    "src/app/api/admin/customers/[customerId]/redaction-ranges/[rangeId]/route.ts",
  "customer_retention_policy.updated":
    "src/app/api/admin/customers/[customerId]/retention/route.ts",
  // Detection event ingestion
  "detection_events.transfer_approved":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "detection_events.transfer_failed":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "detection_events.transfer_denied":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "detection_events.transfer_rejected":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "detection_events.transfer_not_found":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "detection_events.upload_completed": "src/app/api/events/ingest/route.ts",
  "detection_events.upload_failed": "src/app/api/events/ingest/route.ts",
  "detection_events.upload_denied": "src/app/api/events/ingest/route.ts",
  // Customer DB
  "customer_db.provisioned": "src/lib/db/provision-customer.ts",
  "customer_db.provision_failed": "src/lib/db/provision-customer.ts",
  "customer_db.dropped": "src/lib/auth/delete-customer.ts",
  // OpenBao Transit (guard-level: kek_rotated)
  "openbao.kek_rotated": "src/app/api/admin/kek/rotate/route.ts",
  "openbao.dek_destroyed": "src/lib/auth/delete-customer.ts",
  // System (guard-level: settings_updated)
  "system.settings_updated": "src/app/api/admin/session-policy/route.ts",
  // Phase 2 ingest (emitted by all three batch routes — list one)
  "phase2.ingest": "src/app/api/phase2/baseline/batch/route.ts",
  "phase2.ingest_failed": "src/app/api/phase2/_shared/handler.ts",
  "phase2.verification_failed": "src/app/api/phase2/_shared/handler.ts",
  // Phase 2 mutations
  "phase2.withdraw": "src/app/api/phase2/withdraw/route.ts",
  "phase2.refresh_window": "src/app/api/phase2/refresh-window/route.ts",
  "phase2.backfill": "src/app/api/phase2/backfill/route.ts",
  // AI analysis (emitted by POST /api/analysis/analyze)
  "ai_analysis.request_issued": "src/app/api/analysis/analyze/route.ts",
  "ai_analysis.result_stored": "src/app/api/analysis/analyze/route.ts",
  "ai_analysis.aimer_call_failed": "src/app/api/analysis/analyze/route.ts",
  "ai_analysis.hallucination_detected": "src/app/api/analysis/analyze/route.ts",
  // Redaction (emitted by Phase 1 approve, Phase 2 handler, and the
  // analyze route's local-redaction catch)
  "redaction.injectivity_violation":
    "src/app/api/events/staged/[payloadId]/customers/[customerId]/route.ts",
  "redaction.engine_error": "src/app/api/analysis/analyze/route.ts",
  // AICE environment management (guard-level)
  "environment.created": "src/app/api/admin/environments/route.ts",
  "environment.updated": "src/app/api/admin/environments/[aiceId]/route.ts",
  "environment.deleted": "src/app/api/admin/environments/[aiceId]/route.ts",
  "environment.customer_linked":
    "src/app/api/admin/environments/[aiceId]/customers/route.ts",
  "environment.customer_unlinked":
    "src/app/api/admin/environments/[aiceId]/customers/[customerId]/route.ts",
  // Trust registry (guard-level)
  "trust_registry.key_registered":
    "src/app/api/admin/environments/[aiceId]/trust-registry/route.ts",
  "trust_registry.key_disabled":
    "src/app/api/admin/environments/[aiceId]/trust-registry/[keyId]/route.ts",
  "trust_registry.key_removed":
    "src/app/api/admin/environments/[aiceId]/trust-registry/[keyId]/route.ts",
  // Admin designation
  "admin.designated": "src/app/api/admin/admins/route.ts",
  "admin.revoked": "src/app/api/admin/admins/[accountId]/route.ts",
  // Retention sweeper
  "retention_sweep.tick_started": "src/lib/retention/sweeper.ts",
  "retention_sweep.tick_completed": "src/lib/retention/sweeper.ts",
  "retention_sweep.tick_failed": "src/lib/retention/sweeper.ts",
  // Audit (internal) — emitted via raw SQL in anonymize.ts
  "audit.anonymize": "src/lib/audit/anonymize.ts",
} satisfies Partial<Record<AuditAction, string>>;

// ---------------------------------------------------------------------------
// Actions defined in the taxonomy but not yet produced.
// These belong to features not yet built (account management, environment
// management, trust registry, role management, analyst assignments).
// When a feature is built, move its actions from here to PRODUCED.
// ---------------------------------------------------------------------------

const NOT_YET_PRODUCED: Set<AuditAction> = new Set([
  // Account management — no admin routes yet
  "account.created",
  "account.updated",
  "account.suspended",
  "account.restored",
  "account.disabled",
  "account.admin_eligible_changed",
  "account.analyst_eligible_changed",
  // Membership — implicit creation (via invitation acceptance), last_manager guard
  "membership.created",
  "membership.last_manager_blocked",
  // Analyst assignment — no routes yet
  "analyst.assignment.created",
  "analyst.assignment.removed",
  // Customer lifecycle — update/suspend/disable routes not yet built
  "customer.updated",
  "customer.suspended",
  "customer.disabled",
  // AICE environment — environment.disabled not yet used (status changes use environment.updated)
  "environment.disabled",
  // Role management — no routes yet
  "role.created",
  "role.updated",
  "role.deleted",
  "role.permission_changed",
  // Customer DB — retry path not yet wired to provisionCustomerDb
  "customer_db.provision_retried",
  // Detection events — transfer_completed not yet wired
  "detection_events.transfer_completed",
  // System — policy_changed not yet distinct from settings_updated
  "system.policy_changed",
]);

// ---------------------------------------------------------------------------
// Discussion #10 §4 required category prefixes
// ---------------------------------------------------------------------------

const REQUIRED_CATEGORIES = [
  "general.auth",
  "admin.auth",
  "session",
  "bridge",
  "invitation",
  "account",
  "membership",
  "analyst.assignment",
  "customer",
  "environment",
  "trust_registry",
  "role",
  "detection_events",
  "customer_db",
  "openbao",
  "system",
  "phase2",
  "retention_sweep",
  "audit",
  "redaction",
  "ai_analysis",
];

/** Categories whose routes are built and must have at least one producer. */
const PRODUCED_CATEGORIES = [
  "general.auth",
  "admin.auth",
  "session",
  "bridge",
  "invitation",
  "membership",
  "customer",
  "environment",
  "trust_registry",
  "detection_events",
  "customer_db",
  "openbao",
  "system",
  "phase2",
  "retention_sweep",
  "audit",
  "redaction",
  "ai_analysis",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit event taxonomy completeness (Discussion #10 §4)", () => {
  const allActions = extractAuditActions();

  it("every AuditAction is either PRODUCED or explicitly NOT_YET_PRODUCED", () => {
    const unaccounted = allActions.filter(
      (action) =>
        !(action in PRODUCED) && !NOT_YET_PRODUCED.has(action as AuditAction),
    );
    expect(
      unaccounted,
      `Actions not accounted for: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  it("PRODUCED + NOT_YET_PRODUCED has no entries missing from AuditAction", () => {
    const actionSet = new Set(allActions);
    const staleProduced = Object.keys(PRODUCED).filter(
      (key) => !actionSet.has(key),
    );
    const staleNotYet = [...NOT_YET_PRODUCED].filter(
      (key) => !actionSet.has(key),
    );
    const stale = [...staleProduced, ...staleNotYet];
    expect(
      stale,
      `Stale entries not in AuditAction type: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("no action appears in both PRODUCED and NOT_YET_PRODUCED", () => {
    const overlap = Object.keys(PRODUCED).filter((key) =>
      NOT_YET_PRODUCED.has(key as AuditAction),
    );
    expect(overlap, `Actions in both maps: ${overlap.join(", ")}`).toEqual([]);
  });

  it("every required category has at least one action defined", () => {
    for (const category of REQUIRED_CATEGORIES) {
      const matching = allActions.filter(
        (action) => action.startsWith(`${category}.`) || action === category,
      );
      expect(
        matching.length,
        `Category "${category}" has no actions defined`,
      ).toBeGreaterThan(0);
    }
  });

  it("every produced category has at least one produced action", () => {
    for (const category of PRODUCED_CATEGORIES) {
      const matching = Object.keys(PRODUCED).filter(
        (action) => action.startsWith(`${category}.`) || action === category,
      );
      expect(
        matching.length,
        `Category "${category}" has no produced actions — ` +
          "add a producer or move from NOT_YET_PRODUCED",
      ).toBeGreaterThan(0);
    }
  });
});
