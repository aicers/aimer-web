import { getTranslations } from "next-intl/server";

export default async function AdminPage() {
  const t = await getTranslations("admin");
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("settings")}
        </h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          System administration pages are under construction.
        </p>
      </div>
    </div>
  );
}
