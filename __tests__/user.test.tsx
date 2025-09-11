import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { nestMessages } from "../src/i18n/messages";
import "@testing-library/jest-dom";

// Mock server helpers so getTranslations() can be called in this test
vi.mock("next-intl/server", () => {
  const nested = nestMessages(en as Record<string, string>) as Record<
    string,
    unknown
  >;
  function get(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce<unknown>((acc: unknown, k: string) => {
      if (
        acc &&
        typeof acc === "object" &&
        k in (acc as Record<string, unknown>)
      ) {
        return (acc as Record<string, unknown>)[k];
      }
      return undefined;
    }, obj);
  }
  return {
    getTranslations: async () => {
      return (key: string, values?: Record<string, unknown>) => {
        let msg = String(get(nested, key) ?? key);
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            msg = msg.replaceAll(`{${k}}`, String(v));
          }
        }
        return msg;
      };
    },
    getLocale: async () => "en",
    getMessages: async () => nested,
  };
});

test("renders user app page", async () => {
  const UserAppPage = (await import("../src/app/[locale]/user/page")).default;
  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      {await UserAppPage()}
    </NextIntlClientProvider>,
  );
  expect(screen.getByText("User App")).toBeInTheDocument();
});
