import { getTranslations } from "next-intl/server";
import { OverviewSkeleton } from "@/components/overview/overview-rows";

// Shown while the Suspicious Events overview awaits the cross-customer fan-out.
export default async function Loading() {
  const t = await getTranslations("analysis");
  return <OverviewSkeleton loadingLabel={t("overview.loading")} />;
}
