import { getTranslations } from "next-intl/server";
import { AnalysisDefaultModelSection } from "./analysis-default-model-section";
import { CustomerDefaultModelSection } from "./customer-default-model-section";

export default async function AdminPage() {
  const t = await getTranslations("admin");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t("settings")}</h1>
      </div>
      <div className="space-y-6">
        <AnalysisDefaultModelSection />
        <CustomerDefaultModelSection />
      </div>
    </div>
  );
}
