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

export interface EnvironmentEntry {
  aiceId: string;
  name: string;
}
