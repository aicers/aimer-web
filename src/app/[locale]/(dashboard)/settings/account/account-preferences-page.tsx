"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { apiFetch } from "@/lib/api/client";

/** IANA zones offered in the timezone control, from the runtime's own DB. */
function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === "function") {
    return intl.supportedValuesOf("timeZone");
  }
  return [];
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function AccountPreferencesPage() {
  const t = useTranslations("accountSettings");
  const { me } = useCustomerContext();
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const timeZones = useMemo(() => supportedTimeZones(), []);

  const [language, setLanguage] = useState<string>(me?.locale ?? currentLocale);
  const [timezone, setTimezone] = useState<string>(me?.timezone ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function onSave() {
    setStatus("saving");
    try {
      await apiFetch("/api/account/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          locale: language,
          timezone: timezone === "" ? null : timezone,
        }),
      });
      setStatus("saved");

      // Apply the language change immediately: mirror the cookie and
      // switch the URL locale (the saved preference takes effect on the
      // next navigation; this makes it the current one).
      if (language !== currentLocale) {
        // biome-ignore lint/suspicious/noDocumentCookie: next-intl reads the cookie for locale persistence
        document.cookie = `NEXT_LOCALE=${language};path=/;max-age=31536000`;
        localStorage.setItem("locale", language);
        router.replace(pathname, { locale: language });
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="account-language"
          className="block text-sm font-medium text-foreground"
        >
          {t("languageLabel")}
        </label>
        <Select
          id="account-language"
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value);
            setStatus("idle");
          }}
        >
          {routing.locales.map((loc) => (
            <option key={loc} value={loc}>
              {loc === "en" ? t("localeName.en") : t("localeName.ko")}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("languageHelp")}</p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="account-timezone"
          className="block text-sm font-medium text-foreground"
        >
          {t("timezoneLabel")}
        </label>
        <Select
          id="account-timezone"
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
            setStatus("idle");
          }}
        >
          <option value="">{t("timezoneAuto")}</option>
          {timeZones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("timezoneHelp")}</p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={status === "saving"}>
          {status === "saving" ? t("saving") : t("save")}
        </Button>
        {status === "saved" && (
          <span className="text-sm text-muted-foreground">{t("saved")}</span>
        )}
        {status === "error" && (
          <span className="text-sm text-destructive">{t("error")}</span>
        )}
      </div>
    </div>
  );
}
