import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";

import { themeConfig } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aimer Web",
  description: "Aimer Web Application",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>
        <ThemeProvider {...themeConfig}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
