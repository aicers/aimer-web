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
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountTimezoneProvider } from "@/hooks/use-account-timezone";
import {
  formatDateTime,
  formatDateTimeCompact,
  formatDateTimePremount,
} from "@/lib/datetime/format-timestamp";
import { Timestamp } from "../timestamp";

afterEach(() => cleanup());

const instant = new Date("2026-06-03T05:05:30Z");

function withProviders(
  ui: React.ReactElement,
  { timezone = "Asia/Seoul", locale = "en" } = {},
) {
  return (
    <NextIntlClientProvider locale={locale} messages={{}}>
      <AccountTimezoneProvider timezone={timezone}>
        {ui}
      </AccountTimezoneProvider>
    </NextIntlClientProvider>
  );
}

function renderTimestamp(
  ui: React.ReactElement,
  opts: { timezone?: string; locale?: string } = {},
) {
  return render(withProviders(ui, opts));
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

  it("pins the deterministic pre-mount helper to fixed-locale UTC strings", () => {
    // The pre-mount value must be byte-identical on server and client, so it
    // is a fixed-locale (`en-US`) UTC render regardless of browser/app locale.
    expect(formatDateTimePremount(instant)).toBe("6/3/2026, 5:05:30 AM");
    expect(formatDateTimePremount(instant, true)).toBe("6/3, 5:05 AM");
  });

  it("renders the pre-mount value on the server, then hydrates without a mismatch and settles", async () => {
    // Exercise the bridge at the component boundary, not just the helper:
    // the *server* render must emit the deterministic pre-mount value (never
    // the browser-locale formatter), the first client paint must match it
    // byte-for-byte (so hydration warns nothing), and only after mount may it
    // settle to the resolved timezone/locale value.
    const ui = withProviders(<Timestamp at={instant} />, {
      timezone: "Asia/Seoul",
    });

    const serverHtml = renderToString(ui);
    expect(serverHtml).toContain(formatDateTimePremount(instant));
    // The browser-locale formatter renders in Asia/Seoul, which the server
    // cannot know; it must NOT leak into server output.
    expect(serverHtml).not.toContain(formatDateTime(instant, "Asia/Seoul"));

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const time = container.querySelector("time");
    // First client paint (the DOM React hydrates onto) equals the server's.
    expect(time?.textContent).toBe(formatDateTimePremount(instant));

    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, ui);
    });
    spy.mockRestore();

    // No hydration-mismatch warning surfaced during hydration.
    expect(
      errors.some((args) => args.some((a) => /hydrat/i.test(String(a)))),
    ).toBe(false);

    // After mount it settles to the resolved timezone value.
    await waitFor(() => {
      expect(time?.textContent).toBe(formatDateTime(instant, "Asia/Seoul"));
    });

    act(() => root?.unmount());
    container.remove();
  });

  it("accepts an RFC 3339 string", () => {
    renderTimestamp(<Timestamp at="2026-06-03T05:05:30Z" />, {
      timezone: "UTC",
    });
    const el = screen.getByText(formatDateTime("2026-06-03T05:05:30Z", "UTC"));
    expect(el.getAttribute("datetime")).toBe("2026-06-03T05:05:30Z");
  });
});
