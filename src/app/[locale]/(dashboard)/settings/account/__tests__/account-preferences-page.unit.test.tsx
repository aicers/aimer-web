// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `useTranslations` returns the key verbatim so labels are stable to query by;
// `useLocale` pins the app locale so the preview/`'app'` resolution is
// deterministic regardless of the host.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/hooks/use-customer-context", () => ({
  useCustomerContext: vi.fn(),
}));

// `Intl.supportedValuesOf` is environment-dependent; stub the timezone list so
// the control renders a known option without depending on the host's zone DB.
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/settings/account",
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

import { useCustomerContext } from "@/hooks/use-customer-context";
import { apiFetch } from "@/lib/api/client";
import { AccountPreferencesPage } from "../account-preferences-page";

const mockedUseCustomerContext = vi.mocked(useCustomerContext);
const mockedApiFetch = vi.mocked(apiFetch);

/** A `me` with no display-format preference set (every field `null`). */
function meWith(
  overrides: Partial<{
    timezone: string | null;
    timeFormatLocale: string | null;
    timeFormatHourCycle: "h12" | "h23" | null;
    timeFormatSeconds: boolean | null;
    timeFormatTzLabel: boolean | null;
  }> = {},
) {
  return {
    me: {
      locale: "en",
      timezone: "Asia/Seoul",
      timeFormatLocale: null,
      timeFormatHourCycle: null,
      timeFormatSeconds: null,
      timeFormatTzLabel: null,
      ...overrides,
    },
  } as unknown as ReturnType<typeof useCustomerContext>;
}

afterEach(() => cleanup());

describe("AccountPreferencesPage display-format controls (#556)", () => {
  beforeEach(() => {
    mockedUseCustomerContext.mockReset();
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({});
  });

  it("initializes the controls from the saved preference", () => {
    mockedUseCustomerContext.mockReturnValue(
      meWith({
        timeFormatLocale: "en-GB",
        timeFormatHourCycle: "h23",
        timeFormatSeconds: false,
        timeFormatTzLabel: true,
      }),
    );
    render(<AccountPreferencesPage />);

    expect(
      (screen.getByLabelText("timeFormatLocaleLabel") as HTMLSelectElement)
        .value,
    ).toBe("en-GB");
    expect(
      (screen.getByLabelText("hourCycleLabel") as HTMLSelectElement).value,
    ).toBe("h23");
    expect(
      (screen.getByLabelText("secondsLabel") as HTMLSelectElement).value,
    ).toBe("hide");
    expect(
      (screen.getByLabelText("tzLabelLabel") as HTMLSelectElement).value,
    ).toBe("show");
  });

  it("renders a live preview that updates as the options change", () => {
    mockedUseCustomerContext.mockReturnValue(meWith());
    render(<AccountPreferencesPage />);

    // Default (browser locale) preview shows seconds and no GMT label.
    const general = () => screen.getByText("previewGeneral").parentElement;
    const compact = () => screen.getByText("previewCompact").parentElement;
    expect(general()?.textContent).toContain(":05:30");
    expect(general()?.textContent).not.toContain("GMT");

    // Pick en-GB / 24h / hide seconds / show tz label.
    fireEvent.change(screen.getByLabelText("timeFormatLocaleLabel"), {
      target: { value: "en-GB" },
    });
    fireEvent.change(screen.getByLabelText("hourCycleLabel"), {
      target: { value: "h23" },
    });
    fireEvent.change(screen.getByLabelText("secondsLabel"), {
      target: { value: "hide" },
    });
    fireEvent.change(screen.getByLabelText("tzLabelLabel"), {
      target: { value: "show" },
    });

    // General honours all four options (day-first, 24h, no seconds, GMT+9).
    expect(general()?.textContent).toContain("03/06/2026, 23:05 GMT+9");
    // Compact honours only locale + hour cycle: no seconds, no GMT label.
    expect(compact()?.textContent).toContain("03/06, 23:05");
    expect(compact()?.textContent).not.toContain("GMT");
    expect(compact()?.textContent).not.toContain(":30");
  });

  it("saves explicit choices, mapping each control onto the stored shape", async () => {
    mockedUseCustomerContext.mockReturnValue(meWith());
    render(<AccountPreferencesPage />);

    fireEvent.change(screen.getByLabelText("timeFormatLocaleLabel"), {
      target: { value: "en-GB" },
    });
    fireEvent.change(screen.getByLabelText("hourCycleLabel"), {
      target: { value: "h23" },
    });
    fireEvent.change(screen.getByLabelText("secondsLabel"), {
      target: { value: "hide" },
    });
    fireEvent.change(screen.getByLabelText("tzLabelLabel"), {
      target: { value: "show" },
    });
    fireEvent.click(screen.getByText("save"));

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedApiFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      timeFormatLocale: "en-GB",
      timeFormatHourCycle: "h23",
      timeFormatSeconds: false,
      timeFormatTzLabel: true,
    });
  });

  it("persists the unset defaults as null (the empty-string selections)", async () => {
    mockedUseCustomerContext.mockReturnValue(meWith());
    render(<AccountPreferencesPage />);

    fireEvent.click(screen.getByText("save"));

    const [, init] = mockedApiFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      timeFormatLocale: null,
      timeFormatHourCycle: null,
      timeFormatSeconds: null,
      timeFormatTzLabel: null,
    });
  });
});
