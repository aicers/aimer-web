import { useTranslations } from "next-intl";

export default function AnalysisPage() {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-foreground">
        {t("analysis")}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {tCommon("comingSoon")}
      </p>
    </div>
  );
}
