export interface MeResponse {
  accountId: string;
  sessionId: string;
  authContext: string;
  username: string;
  displayName: string;
  email: string | null;
  locale: string | null;
  timezone: string | null;
  memberships: Membership[];
}

export interface Membership {
  customerId: string;
  customerName: string;
  roleId: number;
  roleName: string;
}

export interface Member {
  accountId: string;
  displayName: string;
  email: string | null;
  roleId: number;
  roleName: string;
  lastSignInAt: string | null;
}

export interface Role {
  id: number;
  name: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
}
