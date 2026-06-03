import { forbidden, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { loadScopePage } from "@/lib/navigation/scope-page-loader";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Cross-customer overview surface (#390). WS1 only plumbs the scope to the
// page: the active `?scope=` is read server-side, canonicalized via a
// page-level redirect, and bridge sessions are short-circuited. Rendering
// the overview under the resolved scope is WS2 (#391), so the body is still
// a "coming soon" placeholder.
export default async function AnalysisPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const sp = (await searchParams) ?? {};

  const outcome = await loadScopePage({
    pathname: `/${locale}/analysis`,
    searchParams: sp,
  });

  if (outcome.kind === "unauthorized") redirect("/api/auth/sign-in");
  if (outcome.kind === "redirect") redirect(outcome.target);
  // Bridge sessions cannot read cross-customer surfaces (#390), mirroring the
  // per-customer report loaders' bridge → forbidden mapping.
  if (outcome.kind === "bridge") forbidden();

  const t = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">{t("analysis")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {tCommon("comingSoon")}
      </p>
    </div>
  );
}
