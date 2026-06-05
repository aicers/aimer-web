import { getTranslations } from "next-intl/server";
import { OverviewSkeleton } from "@/components/overview/overview-rows";

// Shown while the combined landing awaits the cross-customer fan-out (#391).
export default async function Loading() {
  const t = await getTranslations("analysis");
  return <OverviewSkeleton rows={6} loadingLabel={t("overview.loading")} />;
}
