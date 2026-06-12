"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useCustomerContext } from "@/hooks/use-customer-context";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { apiFetch } from "@/lib/api/client";
import type { MeResponse } from "@/lib/api/types";
import {
  formatDateTime,
  formatDateTimeCompact,
  resolveDisplayTimeZone,
  resolveTimeFormat,
  type StoredTimeFormat,
  TIME_FORMAT_LOCALE_APP,
  TIME_FORMAT_LOCALES,
  type TimeFormatHourCycle,
} from "@/lib/datetime/format-timestamp";

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

/**
 * The fields the preferences `PATCH` echoes back — the subset of `MeResponse`
 * this page persists. Merged into the shared `me` after a successful save.
 */
type SavedPreferences = Pick<
  MeResponse,
  | "locale"
  | "timezone"
  | "timeFormatLocale"
  | "timeFormatHourCycle"
  | "timeFormatSeconds"
  | "timeFormatTzLabel"
>;

/** A representative afternoon instant for the live format preview. */
const PREVIEW_INSTANT = new Date("2026-06-03T14:05:30Z");

export function AccountPreferencesPage() {
  const t = useTranslations("accountSettings");
  const { me, updateMe } = useCustomerContext();
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const timeZones = useMemo(() => supportedTimeZones(), []);

  const [language, setLanguage] = useState<string>(me?.locale ?? currentLocale);
  const [timezone, setTimezone] = useState<string>(me?.timezone ?? "");
  // The display-format controls (#556). The empty string is the "default"
  // selection, which persists as SQL `NULL` (= use the app default).
  const [tfLocale, setTfLocale] = useState<string>(me?.timeFormatLocale ?? "");
  const [tfHourCycle, setTfHourCycle] = useState<string>(
    me?.timeFormatHourCycle ?? "",
  );
  const [tfSeconds, setTfSeconds] = useState<string>(
    me?.timeFormatSeconds === false ? "hide" : "",
  );
  const [tfTzLabel, setTfTzLabel] = useState<string>(
    me?.timeFormatTzLabel === true ? "show" : "",
  );
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The preview's default ("follow browser") resolves the browser locale and
  // timezone, which are unknown on the server — so, like `<Timestamp>` (#555),
  // render it only after mount to avoid a hydration mismatch. Pre-mount the
  // server and first client paint are byte-identical (no preview text).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Map the control selections onto the stored shape (empty string ⇒ NULL).
  const storedTimeFormat: StoredTimeFormat = useMemo(
    () => ({
      locale: tfLocale === "" ? null : tfLocale,
      hourCycle:
        tfHourCycle === "" ? null : (tfHourCycle as TimeFormatHourCycle),
      seconds: tfSeconds === "hide" ? false : null,
      tzLabel: tfTzLabel === "show" ? true : null,
    }),
    [tfLocale, tfHourCycle, tfSeconds, tfTzLabel],
  );

  // Live preview of the sample instant rendered with the current selections.
  // The `'app'` sentinel and the compact fallback resolve against the *pending*
  // `language` selection (not the route locale `currentLocale`): saving applies
  // that language, so the preview must reflect what the user will actually get
  // once they save — picking "Follow app language" + Korean should preview in
  // Korean immediately, before navigation. Compact honours only locale + hour
  // cycle.
  const preview = useMemo(() => {
    if (!mounted) return { general: "", compact: "" };
    const resolved = resolveTimeFormat(storedTimeFormat, language);
    const tz = resolveDisplayTimeZone(timezone === "" ? null : timezone);
    return {
      general: formatDateTime(PREVIEW_INSTANT, tz, resolved),
      compact: formatDateTimeCompact(
        PREVIEW_INSTANT,
        tz,
        resolved.locale ?? language,
        { hourCycle: resolved.hourCycle },
      ),
    };
  }, [mounted, storedTimeFormat, timezone, language]);

  function markDirty() {
    setStatus("idle");
  }

  async function onSave() {
    setStatus("saving");
    try {
      const updated = await apiFetch<SavedPreferences>(
        "/api/account/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            locale: language,
            timezone: timezone === "" ? null : timezone,
            timeFormatLocale: storedTimeFormat.locale,
            timeFormatHourCycle: storedTimeFormat.hourCycle,
            timeFormatSeconds: storedTimeFormat.seconds,
            timeFormatTzLabel: storedTimeFormat.tzLabel,
          }),
        },
      );
      // Push the saved values into the shared `me` so the timezone and
      // display-format providers re-render every `<Timestamp>` in the live
      // session — without this the change would only show after a reload.
      updateMe(updated);
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
            markDirty();
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
            markDirty();
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

      <div className="space-y-6 border-t border-border pt-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {t("timeFormatTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("timeFormatDescription")}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="time-format-locale"
            className="block text-sm font-medium text-foreground"
          >
            {t("timeFormatLocaleLabel")}
          </label>
          <Select
            id="time-format-locale"
            value={tfLocale}
            onChange={(e) => {
              setTfLocale(e.target.value);
              markDirty();
            }}
          >
            <option value="">{t("timeFormatLocaleBrowser")}</option>
            <option value={TIME_FORMAT_LOCALE_APP}>
              {t("timeFormatLocaleApp")}
            </option>
            {TIME_FORMAT_LOCALES.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("timeFormatLocaleHelp")}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="time-format-hour-cycle"
            className="block text-sm font-medium text-foreground"
          >
            {t("hourCycleLabel")}
          </label>
          <Select
            id="time-format-hour-cycle"
            value={tfHourCycle}
            onChange={(e) => {
              setTfHourCycle(e.target.value);
              markDirty();
            }}
          >
            <option value="">{t("hourCycleAuto")}</option>
            <option value="h12">{t("hourCycle12")}</option>
            <option value="h23">{t("hourCycle24")}</option>
          </Select>
          <p className="text-xs text-muted-foreground">{t("hourCycleHelp")}</p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="time-format-seconds"
            className="block text-sm font-medium text-foreground"
          >
            {t("secondsLabel")}
          </label>
          <Select
            id="time-format-seconds"
            value={tfSeconds}
            onChange={(e) => {
              setTfSeconds(e.target.value);
              markDirty();
            }}
          >
            <option value="">{t("secondsShow")}</option>
            <option value="hide">{t("secondsHide")}</option>
          </Select>
          <p className="text-xs text-muted-foreground">{t("secondsHelp")}</p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="time-format-tz-label"
            className="block text-sm font-medium text-foreground"
          >
            {t("tzLabelLabel")}
          </label>
          <Select
            id="time-format-tz-label"
            value={tfTzLabel}
            onChange={(e) => {
              setTfTzLabel(e.target.value);
              markDirty();
            }}
          >
            <option value="">{t("tzLabelHide")}</option>
            <option value="show">{t("tzLabelShow")}</option>
          </Select>
          <p className="text-xs text-muted-foreground">{t("tzLabelHelp")}</p>
        </div>

        <div className="space-y-2 rounded-md bg-muted/50 p-4">
          <p className="text-sm font-medium text-foreground">
            {t("previewLabel")}
          </p>
          <dl className="space-y-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-muted-foreground">{t("previewGeneral")}</dt>
              <dd className="font-mono text-foreground">{preview.general}</dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-muted-foreground">{t("previewCompact")}</dt>
              <dd className="font-mono text-foreground">{preview.compact}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">{t("compactNote")}</p>
        </div>
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
