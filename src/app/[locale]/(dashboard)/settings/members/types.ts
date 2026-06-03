export type { Membership, MeResponse } from "@/lib/api/types";

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
