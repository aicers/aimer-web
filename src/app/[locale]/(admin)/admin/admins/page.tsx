import { getTranslations } from "next-intl/server";

import { AdminsPage } from "./admins-page";

const MAX_ADMINS = 3;

export default async function Page() {
  const t = await getTranslations("adminAdmins");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("description", { max: MAX_ADMINS })}
        </p>
      </div>
      <AdminsPage />
    </div>
  );
}
