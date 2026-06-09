export interface MeResponse {
  accountId: string;
  sessionId: string;
  authContext: string;
  username: string;
  displayName: string;
  email: string | null;
  locale: string | null;
  timezone: string | null;
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
