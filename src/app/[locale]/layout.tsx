import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { ThemeProvider } from "next-themes";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { themeConfig } from "@/lib/theme";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Aimer Web",
  description: "Aimer Web Application",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const messages = await getMessages();
  const t = await getTranslations("common");

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <a href="#main-content" className="skip-to-content">
          {t("skipToContent")}
        </a>
        <ThemeProvider {...themeConfig}>
          <NextIntlClientProvider messages={messages}>
            {children}
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
