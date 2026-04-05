import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("nav");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">{t("home")}</h1>
    </div>
  );
}
