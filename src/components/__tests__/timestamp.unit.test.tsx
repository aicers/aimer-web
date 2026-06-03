// @vitest-environment jsdom
//
// `<Timestamp>` renders a UTC instant in the account's display timezone
// (#400), resolving `accounts.timezone` (from the provider) → browser tz →
// UTC. After mount it re-renders in the resolved zone; the machine-readable
// ISO is always exposed via `<time dateTime>`.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountTimezoneProvider } from "@/hooks/use-account-timezone";
import { Timestamp } from "../timestamp";

afterEach(() => cleanup());

const instant = new Date("2026-06-03T05:05:00Z");

describe("Timestamp", () => {
  it("exposes the exact UTC instant via the time element's dateTime", () => {
    render(
      <AccountTimezoneProvider timezone="Asia/Seoul">
        <Timestamp at={instant} />
      </AccountTimezoneProvider>,
    );
    const el = screen.getByText(/2026-06-03/);
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe("2026-06-03T05:05:00.000Z");
  });

  it("formats in the account timezone from the provider after mount", async () => {
    render(
      <AccountTimezoneProvider timezone="Asia/Seoul">
        <Timestamp at={instant} />
      </AccountTimezoneProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("2026-06-03 14:05 GMT+9")).toBeTruthy();
    });
  });

  it("accepts an RFC 3339 string", () => {
    render(
      <AccountTimezoneProvider timezone="UTC">
        <Timestamp at="2026-06-03T05:05:00Z" />
      </AccountTimezoneProvider>,
    );
    const el = screen.getByText(/2026-06-03/);
    expect(el.getAttribute("datetime")).toBe("2026-06-03T05:05:00Z");
  });
});
