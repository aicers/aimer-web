export interface MeResponse {
  accountId: string;
  sessionId: string;
  authContext: string;
  username: string;
  displayName: string;
  email: string | null;
  locale: string | null;
  timezone: string | null;
  /**
   * Date/time display-format preference (#556). Each field is nullable; `null`
   * means "use the app default" (see `accounts.time_format_*`). `timeFormatLocale`
   * is `null` (browser) / `'app'` (app locale) / a curated BCP-47 tag.
   */
  timeFormatLocale: string | null;
  timeFormatHourCycle: "h12" | "h23" | null;
  timeFormatSeconds: boolean | null;
  timeFormatTzLabel: boolean | null;
  analystEligible: boolean;
  bridge: {
    active: boolean;
    aiceId: string | null;
    customerIds: string[] | null;
  };
  memberships: Membership[];
}

export interface Membership {
  customerId: string;
  customerName: string;
  roleId: number;
  roleName: string;
}

export interface CustomerEntry {
  id: string;
  externalKey: string;
  name: string;
  role: string | null;
  isAnalyst: boolean;
  /**
   * Effective permission keys this account holds for this customer,
   * union of membership-role grants and analyst-assignment grants
   * (same set `authorizeGeneral` computes server-side). Used by
   * `usePermissions().hasPermission` for client-side gating.
   */
  permissions: string[];
}

/**
 * A customer group the account can surface as a summary subject (#513).
 * Returned by `GET /api/auth/groups` — only groups where the viewer holds
 * `reports:read` on EVERY member appear, and a bridge session gets none. Drives
 * the sidebar group navigation (a hub link, no `?scope=`) and the scope-filter
 * presets (which expand `memberIds` into the customer multi-select).
 */
export interface GroupEntry {
  id: string;
  name: string;
  description: string | null;
  /** Ordered member customer ids — a scope preset expands the group to these. */
  memberIds: string[];
  /** The group's bucket timezone (`customer_groups.tz`). */
  tz: string;
}

export interface EnvironmentEntry {
  aiceId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Customer group MANAGEMENT surface (#512)
//
// Distinct from the view-scoped {@link GroupEntry} (`GET /api/auth/groups`):
// these back the management settings UI and carry owner / provisioning /
// retention state the view shape intentionally omits. They are gated by the
// stricter all-member management predicate, not `reports:read`.
// ---------------------------------------------------------------------------

/**
 * One group the account may MANAGE, as listed by `GET /api/groups`. Carries a
 * member COUNT (the detail call loads member names) plus owner / provisioning
 * state for the list view.
 */
export interface ManagedGroupSummary {
  id: string;
  name: string;
  memberCount: number;
  /** Group data-DB provisioning state: `provisioning` | `active` | `failed`. */
  databaseStatus: string;
  ownerId: string;
  createdBy: string;
}

/** A group member projected with its display name for the detail surface. */
export interface ManagedGroupMember {
  id: string;
  name: string;
}

/**
 * Single-group detail from `GET /api/groups/[groupId]`, backing the group
 * settings page: members with names, timezone, owner / created-by /
 * provisioning state, and the retention policy.
 */
export interface ManagedGroupDetail {
  id: string;
  name: string;
  description: string | null;
  members: ManagedGroupMember[];
  tz: string;
  ownerId: string;
  createdBy: string;
  databaseStatus: string;
  /** Per-group analysis retention window (days); `null` = no expiry. */
  groupPolicyDays: number | null;
}

/**
 * A customer the account may pick as a group member, from
 * `GET /api/groups/eligible-members`: accessible, manageable, operational, with
 * the timezone the create flow auto-fills from.
 */
export interface GroupEligibleMember {
  id: string;
  name: string;
  externalKey: string;
  timezone: string;
  role: string | null;
  isAnalyst: boolean;
}

/**
 * The `POST /api/groups/preview` response (annotate mode): cost estimate plus
 * tz recommendation. Over-cap and tz divergence annotate rather than 400.
 */
export interface GroupCostPreview {
  memberCount: number;
  maxMembers: number;
  overMemberCap: boolean;
  combinedRecentEventVolume: number | null;
  generationCadence: string[];
  estimatedMonthlyTokens: number | null;
  estimatedMonthlyCostUsd: number | null;
  /** Set when members' timezones diverge and no tz was chosen. */
  recommendedTz?: string;
}
