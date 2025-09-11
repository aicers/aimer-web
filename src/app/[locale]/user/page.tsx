import { getTranslations } from "next-intl/server";

export default async function UserAppPage() {
  const t = await getTranslations();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">{t("user.title")}</h1>
      <p>{t("user.welcome")}</p>
    </main>
  );
}
