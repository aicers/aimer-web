import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import ko from "../messages/ko.json";
import { nestMessages } from "../src/i18n/messages";
import "@testing-library/jest-dom";

beforeEach(() => cleanup());
afterEach(() => cleanup());

// Mock server helpers so getTranslations() can be called in tests
vi.mock("next-intl/server", () => {
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
        const nested = (globalThis as unknown as Record<string, unknown>)
          .__TEST_MESSAGES__ as Record<string, unknown>;
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
    getMessages: async () =>
      (globalThis as unknown as Record<string, unknown>)
        .__TEST_MESSAGES__ as Record<string, unknown>,
  };
});

test("home link renders with /en prefix and English text", async () => {
  const Home = (await import("../src/app/[locale]/page")).default;
  (globalThis as unknown as Record<string, unknown>).__TEST_MESSAGES__ =
    nestMessages(en) as unknown as Record<string, unknown>;
  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      {await Home()}
    </NextIntlClientProvider>,
  );

  expect(screen.getByText(en["home.title"])).toBeInTheDocument();
  const signIn = screen.getByRole("link", { name: en["home.signIn"] });
  expect(signIn.getAttribute("href")).toContain("/en/signin");
});

test("home link renders with /ko prefix and Korean text", async () => {
  const Home = (await import("../src/app/[locale]/page")).default;
  (globalThis as unknown as Record<string, unknown>).__TEST_MESSAGES__ =
    nestMessages(ko) as unknown as Record<string, unknown>;
  render(
    <NextIntlClientProvider messages={nestMessages(ko)} locale="ko">
      {await Home()}
    </NextIntlClientProvider>,
  );

  expect(screen.getByText(ko["home.title"])).toBeInTheDocument();
  const signIn = screen.getByRole("link", { name: ko["home.signIn"] });
  expect(signIn.getAttribute("href")).toContain("/ko/signin");
});

// The sign-in page is a client component that uses next/navigation hooks.
// Use the project-provided mocks.
vi.mock("next/navigation");

test("ko sign-in page renders Korean labels", async () => {
  const SignIn = (await import("../src/app/[locale]/signin/page")).default;
  render(
    <NextIntlClientProvider messages={nestMessages(ko)} locale="ko">
      <SignIn />
    </NextIntlClientProvider>,
  );

  // Placeholders and button label in Korean
  expect(
    screen.getByPlaceholderText(ko["signin.idPlaceholder"]),
  ).toBeInTheDocument();
  expect(
    screen.getByPlaceholderText(ko["signin.passwordPlaceholder"]),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: ko["signin.submit"] }),
  ).toBeInTheDocument();
});
