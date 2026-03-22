import { defineRouting } from "next-intl/routing";

const defaultLocale = (process.env.DEFAULT_LOCALE ?? "ko") as "en" | "ko";

export const routing = defineRouting({
  locales: ["en", "ko"],
  defaultLocale,
  localePrefix: "as-needed",
});
