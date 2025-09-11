import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { nestMessages } from "../src/i18n/messages";
import "@testing-library/jest-dom";

beforeEach(() => cleanup());
afterEach(() => cleanup());

// Provide a minimal mock for next-intl/server to return English messages
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

test("server messages render in localized home page", async () => {
  const Home = (await import("../src/app/[locale]/page")).default;
  const nested = nestMessages(en as Record<string, string>);
  render(
    <NextIntlClientProvider messages={nested} locale="en">
      {await Home()}
    </NextIntlClientProvider>,
  );
  expect(screen.getByText(en["home.title"])).toBeInTheDocument();
});
