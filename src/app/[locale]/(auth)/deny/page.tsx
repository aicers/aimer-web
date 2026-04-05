import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";

type DenyMessageKey =
  | "accountInactive"
  | "noAccess"
  | "adminMfaRequired"
  | "adminAuthTooOld"
  | "adminRoleMissing"
  | "adminNotEligible"
  | "invitationExpired"
  | "invitationEmailMismatch"
  | "invitationEmailNotVerified"
  | "bridgeExpired"
  | "bridgeCustomerMismatch"
  | "bridgeCustomerInactive"
  | "bridgeEnvironmentInactive"
  | "bridgeNoAccess"
  | "genericError";

const REASON_KEYS: Record<string, DenyMessageKey> = {
  account_inactive: "accountInactive",
  no_access: "noAccess",
  admin_mfa_required: "adminMfaRequired",
  admin_auth_too_old: "adminAuthTooOld",
  admin_role_missing: "adminRoleMissing",
  admin_not_eligible: "adminNotEligible",
  invitation_expired: "invitationExpired",
  invitation_email_mismatch: "invitationEmailMismatch",
  invitation_email_not_verified: "invitationEmailNotVerified",
  bridge_expired: "bridgeExpired",
  bridge_customer_mismatch: "bridgeCustomerMismatch",
  bridge_customer_inactive: "bridgeCustomerInactive",
  bridge_environment_inactive: "bridgeEnvironmentInactive",
  bridge_no_access: "bridgeNoAccess",
};

export default async function DenyPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const t = await getTranslations("auth.deny");
  const messageKey: DenyMessageKey =
    (reason && REASON_KEYS[reason]) || "genericError";

  return (
    <div className="w-full max-w-md rounded-md border border-border bg-card p-8 shadow-auth-card">
      <h1 className="mb-4 text-2xl font-bold text-foreground">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t(messageKey)}</p>
      <p className="mt-4 text-sm text-muted-foreground">{t("contactAdmin")}</p>
      <Button asChild className="mt-6 w-full">
        <a href="/api/auth/sign-in">{t("backToSignIn")}</a>
      </Button>
    </div>
  );
}
