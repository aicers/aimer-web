import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function SignInErrorPage() {
  const t = await getTranslations();
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">{t("signin.unsupportedRoleTitle")}</h1>
      <p>{t("signin.unsupportedRoleMessage")}</p>
      <Link href="/signin" className="border rounded px-3 py-2">
        {t("signin.back")}
      </Link>
    </main>
  );
}
