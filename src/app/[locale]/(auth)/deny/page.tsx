import { getTranslations } from "next-intl/server";

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
    <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <h1 className="mb-4 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
        {t("title")}
      </h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        {t(messageKey)}
      </p>
      <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
        {t("contactAdmin")}
      </p>
      <a
        href="/api/auth/sign-in"
        className="mt-6 block w-full rounded-md bg-neutral-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {t("backToSignIn")}
      </a>
    </div>
  );
}
