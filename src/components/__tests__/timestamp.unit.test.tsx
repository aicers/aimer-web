// @vitest-environment jsdom
//
// `<Timestamp>` renders a UTC instant in the account's display timezone
// (#400) using aice-web-next's time format (#553), resolving
// `accounts.timezone` (from the provider) → browser tz → UTC. The server /
// first client paint render a deterministic, layout-stable placeholder —
// never a real-looking UTC value (#555); after mount it re-renders through
// the real formatters. The machine-readable ISO is always exposed via
// `<time dateTime>`.

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

  it("renders a layout-stable placeholder pre-mount, never a human-readable value", () => {
    // The *server* render must emit a deterministic placeholder, never the
    // browser-locale formatter: no real time value appears in the visible
    // text, but the machine-readable ISO and the busy marker do.
    const serverHtml = renderToString(
      withProviders(<Timestamp at={instant} />, { timezone: "Asia/Seoul" }),
    );

    // The browser-locale formatter renders in Asia/Seoul, which the server
    // cannot know; it must NOT leak into server output. Nor must any other
    // human-readable time value (e.g. the old UTC pre-mount string) — the
    // year is a reliable tell, and it must not surface in the visible text.
    expect(serverHtml).not.toContain(formatDateTime(instant, "Asia/Seoul"));
    expect(serverHtml).toContain('aria-busy="true"');
    expect(serverHtml).toContain('aria-hidden="true"');
    // The slot reserves a fixed `ch` footprint rather than collapsing.
    expect(serverHtml).toMatch(/min-width:\s*\d/);

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    const time = container.querySelector("time");
    // The machine-readable ISO stays exposed throughout.
    expect(time?.getAttribute("datetime")).toBe("2026-06-03T05:05:30.000Z");
    // No real time value (the year is a reliable tell) in the visible text.
    expect(time?.textContent).not.toMatch(/2026/);
  });

  it("reserves the same fixed width for the placeholder and the resolved value", async () => {
    // The placeholder min-width (pre-mount) and the resolved value's min-width
    // (post-mount) must match so swapping in the real value shifts nothing.
    const serverHtml = renderToString(
      withProviders(<Timestamp at={instant} />, { timezone: "Asia/Seoul" }),
    );
    const reserved = serverHtml.match(/min-width:\s*([\d.]+ch)/)?.[1];
    expect(reserved).toBeTruthy();

    const { container } = renderTimestamp(<Timestamp at={instant} />, {
      timezone: "Asia/Seoul",
    });
    await waitFor(() => {
      expect(
        screen.getByText(formatDateTime(instant, "Asia/Seoul")),
      ).toBeTruthy();
    });
    const time = container.querySelector("time");
    expect(time?.style.minWidth).toBe(reserved);
    // The busy marker is cleared once the real value is shown.
    expect(time?.getAttribute("aria-busy")).toBeNull();
  });

  it("hydrates the placeholder without a mismatch, then settles", async () => {
    // The first client paint (the DOM React hydrates onto) must match the
    // server's byte-for-byte (so hydration warns nothing), and only after
    // mount may it settle to the resolved timezone/locale value.
    const ui = withProviders(<Timestamp at={instant} />, {
      timezone: "Asia/Seoul",
    });

    const serverHtml = renderToString(ui);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const time = container.querySelector("time");
    // Pre-mount the placeholder shows no real value.
    expect(time?.textContent).not.toMatch(/2026/);

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
