import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("nav");
  return (
    <div className="flex h-full items-center justify-center">
      <h1 className="text-2xl font-bold text-foreground">{t("dashboard")}</h1>
    </div>
  );
}
