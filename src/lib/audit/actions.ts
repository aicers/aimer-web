/**
 * Canonical audit action names per Discussion #10 §4.
 *
 * Adding or removing an action here is intentional — the TypeScript
 * compiler will flag every call site that uses a stale name.
 */
export type AuditAction =
  // General auth
  | "general.auth.sign_in_success"
  | "general.auth.sign_in_denied"
  | "general.auth.sign_out"
  | "general.auth.sign_out_all"
  // Admin auth
  | "admin.auth.sign_in_success"
  | "admin.auth.sign_in_denied"
  | "admin.auth.sign_out"
  | "admin.auth.sign_out_all"
  // Session
  | "session.ip_mismatch"
  | "session.ua_mismatch"
  | "session.idle_timeout"
  | "session.absolute_timeout"
  | "session.revoked"
  | "session.cross_context_mismatch"
  // Bridge
  | "bridge.connection_request"
  | "bridge.connection_granted"
  | "bridge.connection_denied"
  | "bridge.write_attempt_blocked"
  // Invitation
  | "invitation.created"
  | "invitation.accepted"
  | "invitation.failed"
  | "invitation.expired"
  | "invitation.revoked"
  // Account
  | "account.created"
  | "account.updated"
  | "account.suspended"
  | "account.restored"
  | "account.disabled"
  | "account.admin_eligible_changed"
  | "account.analyst_eligible_changed"
  | "account.preferences_updated"
  // Admin designation
  | "admin.designated"
  | "admin.revoked"
  // Membership
  | "membership.created"
  | "membership.role_changed"
  | "membership.removed"
  | "membership.last_manager_blocked"
  // Analyst assignment
  | "analyst.assignment.created"
  | "analyst.assignment.removed"
  // Customer
  | "customer.created"
  | "customer.updated"
  | "customer.suspended"
  | "customer.disabled"
  | "customer.deleted"
  // Customer redaction ranges + retention (Customer Settings UI)
  | "customer_redaction_ranges.added"
  | "customer_redaction_ranges.deleted"
  | "customer_redaction_ranges.retroactive_started"
  | "customer_redaction_ranges.retroactive_completed"
  | "customer_redaction_ranges.retroactive_failed"
  | "customer_redaction_ranges.retroactive_cancelled"
  | "customer_retention_policy.updated"
  // Customer groups (#506)
  | "customer_group.created"
  | "customer_group.deleted"
  | "customer_group.timezone_updated"
  | "group_retention_policy.updated"
  // Customer-group lifecycle enforcement (#510)
  | "customer_group.owner_transferred"
  | "customer_group.auto_deleted"
  | "customer_group.suspended"
  | "customer_group.resumed"
  // Per-customer default analysis model (#473)
  | "customer_default_model.updated"
  | "customer_default_model.cleared"
  | "system.default_model_updated"
  | "system.default_model_cleared"
  // Per-subject TI source selection (RFC 0003 F2, #598). Named for the
  // `subject_ti_sources` table (both subject kinds), not the subject kind.
  | "subject_ti_sources.updated"
  | "subject_ti_sources.cleared"
  | "system.ti_sources_default_updated"
  | "system.ti_sources_default_cleared"
  // Story-leaf re-analysis backfill (#466)
  | "story_reanalysis.backfill_enqueued"
  // Report-variant refresh (#469)
  | "report_refresh.enqueued"
  // AICE environment
  | "environment.created"
  | "environment.updated"
  | "environment.disabled"
  | "environment.deleted"
  | "environment.customer_linked"
  | "environment.customer_unlinked"
  // Trust registry
  | "trust_registry.key_registered"
  | "trust_registry.key_disabled"
  | "trust_registry.key_removed"
  // Role
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "role.permission_changed"
  // Detection event ingestion
  | "detection_events.transfer_approved"
  | "detection_events.transfer_completed"
  | "detection_events.transfer_failed"
  | "detection_events.transfer_denied"
  | "detection_events.transfer_rejected"
  | "detection_events.transfer_not_found"
  | "detection_events.upload_completed"
  | "detection_events.upload_failed"
  | "detection_events.upload_denied"
  // Customer DB
  | "customer_db.provisioned"
  | "customer_db.provision_failed"
  | "customer_db.provision_retried"
  | "customer_db.dropped"
  // Group DB (#507)
  | "group_db.provisioned"
  | "group_db.provision_failed"
  | "group_db.provision_retried"
  | "group_db.dropped"
  // OpenBao Transit
  | "openbao.kek_rotated"
  | "openbao.dek_destroyed"
  // System
  | "system.policy_changed"
  | "system.settings_updated"
  // TI feed self-fetch scheduler (#570)
  | "system.ti_feed_self_fetch_schedule_updated"
  // CVE refresh scheduler (RFC 0005, #611)
  | "system.cve_refresh_schedule_updated"
  // Phase 2 ingest
  | "phase2.ingest"
  | "phase2.ingest_failed"
  | "phase2.verification_failed"
  // Phase 2 mutations
  | "phase2.withdraw"
  | "phase2.refresh_window"
  | "phase2.backfill"
  // AI analysis (POST /api/analysis/analyze)
  | "ai_analysis.request_issued"
  | "ai_analysis.result_stored"
  | "ai_analysis.aimer_call_failed"
  // Emitted right after a successful aimer call, before validation/storage, so
  // a call that is paid for is always recorded even if it later leaks/no-ops
  // (per-call translation cost metering, #581).
  | "ai_analysis.aimer_call_succeeded"
  | "ai_analysis.hallucination_detected"
  | "ai_analysis.ttp_tag_dropped"
  // RFC 0005 — a CVE ref dropped during catalog validation (hallucinated /
  // unconfirmed), the precision mechanism. Carries the drop reason.
  | "ai_analysis.cve_ref_dropped"
  | "ai_analysis.factor_dropped"
  // AI analysis bridge (POST /api/analysis/analyze-bridge + /continue)
  | "ai_analysis.bridge_initiated"
  | "ai_analysis.short_circuit_executed"
  | "ai_analysis.continue_executed"
  | "ai_analysis.continue_failed"
  | "ai_analysis.continue_replayed"
  // Redaction
  | "redaction.injectivity_violation"
  | "redaction.engine_error"
  // Retention sweeper
  | "retention_sweep.tick_started"
  | "retention_sweep.tick_completed"
  | "retention_sweep.tick_failed"
  // Group-report retention reaper (#509)
  | "retention_sweep.group_reaped"
  | "retention_sweep.group_skipped"
  | "retention_sweep.group_failed"
  // Audit (internal)
  | "audit.anonymize";
