import { getRequestConfig } from "next-intl/server";
import { nestMessages } from "./messages";

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = (await requestLocale) ?? "en";
  const flat = (await import(`../../messages/${locale}.json`))
    .default as Record<string, string>;
  return { locale, messages: nestMessages(flat) };
});
