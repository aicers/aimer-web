import { getTranslations } from "next-intl/server";

export default async function AdminAppPage() {
  const t = await getTranslations();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">{t("admin.title")}</h1>
      <p>{t("admin.welcome")}</p>
    </main>
  );
}
