import { expect, getTestPool, test } from "./fixtures";
import { injectAuthCookies } from "./fixtures/auth";

// Self-service account language/timezone preference (L1 / #387).
//
// Covers the PR test plan's behavioural items end-to-end against the
// running dev server:
//  - settings/account persists language + timezone and takes effect,
//  - the header language switcher write-through persists to accounts.locale,
//  - PATCH /api/account/preferences rejects invalid locale / timezone,
//  - the saved preference (mirrored to NEXT_LOCALE) drives resolution and
//    an explicit non-default [locale] prefix still wins for that request.

async function readAccount(
  accountId: string,
): Promise<{ locale: string | null; timezone: string | null }> {
  const { rows } = await getTestPool().query<{
    locale: string | null;
    timezone: string | null;
  }>("SELECT locale, timezone FROM accounts WHERE id = $1", [accountId]);
  return rows[0];
}

async function setAccountLocale(
  accountId: string,
  locale: string | null,
): Promise<void> {
  await getTestPool().query("UPDATE accounts SET locale = $1 WHERE id = $2", [
    locale,
    accountId,
  ]);
}

test.describe("Account preferences — settings page (#387)", () => {
  test("saves language + timezone and switches the active locale", async ({
    managerPage,
    baseURL,
    testData,
  }) => {
    // Start in Korean (the default locale → unprefixed canonical URL).
    // The saved preference is mirrored into NEXT_LOCALE at sign-in
    // (src/lib/auth/locale-sync.ts); the fixture injects only the auth
    // cookies, so mirror it here to reproduce that signed-in state.
    await setAccountLocale(testData.manager.accountId, "ko");
    await managerPage.context().addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ko",
        url: baseURL ?? "http://localhost:3000",
      },
    ]);

    await managerPage.goto("/settings/account");
    await expect(managerPage.locator("html")).toHaveAttribute("lang", "ko");

    // Switch to English (a non-default locale → gets an explicit prefix).
    await managerPage.locator("#account-language").selectOption("en");
    await managerPage.locator("#account-timezone").selectOption("Asia/Seoul");
    // The page is rendering in Korean here, so match either label.
    await managerPage.getByRole("button", { name: /Save|저장/ }).click();

    // Language change takes effect immediately: the URL switches to /en.
    await expect(managerPage).toHaveURL(/\/en\/settings\/account/);
    await expect(managerPage.locator("html")).toHaveAttribute("lang", "en");

    // Persisted to the account.
    const acct = await readAccount(testData.manager.accountId);
    expect(acct.locale).toBe("en");
    expect(acct.timezone).toBe("Asia/Seoul");
  });

  test("Automatic timezone persists as NULL", async ({
    managerPage,
    testData,
  }) => {
    await getTestPool().query(
      "UPDATE accounts SET timezone = $1 WHERE id = $2",
      ["Asia/Seoul", testData.manager.accountId],
    );

    await managerPage.goto("/en/settings/account");
    await managerPage.locator("#account-timezone").selectOption("");
    await managerPage.getByRole("button", { name: "Save" }).click();
    await expect(managerPage.getByText("Preferences saved.")).toBeVisible();

    const acct = await readAccount(testData.manager.accountId);
    expect(acct.timezone).toBeNull();
  });
});

test.describe("Account preferences — header switcher write-through (#387)", () => {
  test("toggling the switcher persists to accounts.locale", async ({
    userPage,
    baseURL,
    testData,
  }) => {
    // Start in Korean; the switcher then offers English (a non-default
    // locale → an explicit /en prefix appears after the toggle).
    await setAccountLocale(testData.user.accountId, "ko");
    await userPage.context().addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ko",
        url: baseURL ?? "http://localhost:3000",
      },
    ]);

    await userPage.goto("/");
    await expect(userPage.locator("html")).toHaveAttribute("lang", "ko");
    await userPage.getByRole("button", { name: "English" }).click();
    await expect(userPage).toHaveURL(/\/en(\/|$)/);
    await expect(userPage.locator("html")).toHaveAttribute("lang", "en");

    // Write-through persisted the choice to the signed-in account.
    await expect
      .poll(async () => (await readAccount(testData.user.accountId)).locale)
      .toBe("en");
  });
});

test.describe("Account preferences — API validation (#387)", () => {
  test("rejects invalid locale and invalid timezone with 400", async ({
    managerPage,
  }) => {
    await managerPage.goto("/en/settings/account");

    const call = (body: unknown) =>
      managerPage.evaluate(async (payload) => {
        const csrf =
          document.cookie
            .split("; ")
            .find((c) => c.startsWith("csrf="))
            ?.split("=")[1] ?? "";
        const res = await fetch("/api/account/preferences", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
          },
          body: JSON.stringify(payload),
        });
        return res.status;
      }, body);

    expect(await call({ locale: "fr" })).toBe(400);
    expect(await call({ timezone: "Not/AZone" })).toBe(400);
    // A valid payload still succeeds through the same path.
    expect(await call({ locale: "en", timezone: "UTC" })).toBe(200);
  });
});

test.describe("Account preferences — resolution order (#387)", () => {
  test("saved preference applies regardless of Accept-Language; explicit non-default prefix wins", async ({
    browser,
    baseURL,
    testData,
  }) => {
    await setAccountLocale(testData.user.accountId, "ko");

    const context = await browser.newContext({
      baseURL: baseURL ?? undefined,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await injectAuthCookies(context, testData.user, "general");
    // Mirror the saved preference into NEXT_LOCALE, as the sign-in
    // callback does (src/lib/auth/locale-sync.ts).
    const host = new URL(baseURL ?? "http://localhost:3000").hostname;
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ko", domain: host, path: "/" },
    ]);
    const page = await context.newPage();

    // No explicit prefix → saved preference (ko) wins over Accept-Language en.
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ko");

    // Explicit non-default prefix /en always wins for that request.
    await page.goto("/en/events");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await context.close();
  });
});
