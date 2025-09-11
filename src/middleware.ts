import createMiddleware from "next-intl/middleware";

export default createMiddleware({
  // Supported locales
  locales: ["en", "ko"],
  defaultLocale: "en",
  localePrefix: "always",
});

export const config = {
  // Skip all paths that aren't pages that require i18n
  matcher: ["/", "/((?!api|_next|.*\\..*).*)"],
};
