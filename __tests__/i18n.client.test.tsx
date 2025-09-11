import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import en from "../messages/en.json";
import { nestMessages } from "../src/i18n/messages";
import "@testing-library/jest-dom";

beforeEach(() => cleanup());
afterEach(() => cleanup());

function ClientComp() {
  const t = useTranslations();
  return (
    <div>
      <h1>{t("home.title")}</h1>
      <button type="button">{t("signin.submit")}</button>
    </div>
  );
}

test("useTranslations returns messages from provider", () => {
  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      <ClientComp />
    </NextIntlClientProvider>,
  );

  expect(screen.getByText(en["home.title"])).toBeInTheDocument();
  expect(screen.getByText(en["signin.submit"])).toBeInTheDocument();
});
