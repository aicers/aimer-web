import { getTranslations } from "next-intl/server";

type DenyMessageKey = "accountInactive" | "noAccess" | "genericError";

const REASON_KEYS: Record<string, DenyMessageKey> = {
  account_inactive: "accountInactive",
  no_access: "noAccess",
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
