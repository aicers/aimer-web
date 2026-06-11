// @vitest-environment jsdom
//
// `<Timestamp>` renders a UTC instant in the account's display timezone
// (#400) using aice-web-next's time format (#553), resolving
// `accounts.timezone` (from the provider) → browser tz → UTC. The server /
// first client paint render a deterministic fixed-locale UTC value; after
// mount it re-renders through the real formatters. The machine-readable ISO
// is always exposed via `<time dateTime>`.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { AccountTimezoneProvider } from "@/hooks/use-account-timezone";
import {
  formatDateTime,
  formatDateTimeCompact,
  formatDateTimePremount,
} from "@/lib/datetime/format-timestamp";
import { Timestamp } from "../timestamp";

afterEach(() => cleanup());

const instant = new Date("2026-06-03T05:05:30Z");

function renderTimestamp(
  ui: React.ReactElement,
  { timezone = "Asia/Seoul", locale = "en" } = {},
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <AccountTimezoneProvider timezone={timezone}>
        {ui}
      </AccountTimezoneProvider>
    </NextIntlClientProvider>,
  );
}

describe("Timestamp", () => {
  it("exposes the exact UTC instant via the time element's dateTime", () => {
    renderTimestamp(<Timestamp at={instant} />);
    const el = screen.getByText(formatDateTime(instant, "Asia/Seoul"));
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe("2026-06-03T05:05:30.000Z");
  });

  it("renders the general format in the account timezone after mount", async () => {
    renderTimestamp(<Timestamp at={instant} />);
    await waitFor(() => {
      expect(
        screen.getByText(formatDateTime(instant, "Asia/Seoul")),
      ).toBeTruthy();
    });
  });

  it("renders the compact format with the active locale after mount", async () => {
    renderTimestamp(<Timestamp at={instant} compact />, { locale: "ko" });
    await waitFor(() => {
      expect(
        screen.getByText(formatDateTimeCompact(instant, "Asia/Seoul", "ko")),
      ).toBeTruthy();
    });
    // Compact drops the year and seconds.
    expect(screen.queryByText(/2026/)).toBeNull();
  });

  it("renders the deterministic pre-mount value identically to the server", () => {
    // react-testing-library mounts synchronously, but the first paint (before
    // the effect resolves the zone) must equal the fixed-locale UTC value so
    // server and client agree. Verify the helper the component renders.
    expect(formatDateTimePremount(instant)).toBe("6/3/2026, 5:05:30 AM");
    expect(formatDateTimePremount(instant, true)).toBe("6/3, 5:05 AM");
  });

  it("accepts an RFC 3339 string", () => {
    renderTimestamp(<Timestamp at="2026-06-03T05:05:30Z" />, {
      timezone: "UTC",
    });
    const el = screen.getByText(formatDateTime("2026-06-03T05:05:30Z", "UTC"));
    expect(el.getAttribute("datetime")).toBe("2026-06-03T05:05:30Z");
  });
});
