import { useTranslations } from "next-intl";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

export default function HomePage() {
  const t = useTranslations("nav");
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center"
    >
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">{t("home")}</h1>
        <div className="mt-4 flex items-center gap-4 justify-center">
          <ThemeToggle />
          <LocaleSwitcher />
        </div>
      </div>
    </main>
  );
}
