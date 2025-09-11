import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function HomePage() {
  const t = await getTranslations();
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
      <h1 className="text-3xl font-bold">{t("home.title")}</h1>
      <div className="flex gap-4">
        <Link
          href="/signin?mode=user"
          className="border rounded px-3 py-2 bg-black text-white"
        >
          {t("home.userSignIn")}
        </Link>
        <Link href="/signin?mode=admin" className="border rounded px-3 py-2">
          {t("home.adminSignIn")}
        </Link>
      </div>
    </main>
  );
}
