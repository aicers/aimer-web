// Unit tests for the old-stub → new-home redirects (WS2, #391).
//
// `/dashboard` → `/overview`, `/events` → `/suspicious-events`, `/analysis`
// → `/overview`. Each must preserve the inbound query string (scope + report-
// variant params) per the parent query-preservation contract — a naive
// `redirect("/...")` would silently reset the active scope. The target page
// canonicalizes the scope itself, so the redirect forwards the value verbatim
// (only key-sorted by `mergeQuery`).

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((target: string) => {
  throw new Error(`REDIRECT:${target}`);
});

vi.mock("next/navigation", () => ({
  redirect: (target: string) => redirectMock(target),
}));

import AnalysisRedirect from "../analysis/page";
import DashboardRedirect from "../dashboard/page";
import EventsRedirect from "../events/page";

type SearchParams = Record<string, string | string[] | undefined>;

async function target(
  page: (props: {
    params: Promise<{ locale: string }>;
    searchParams?: Promise<SearchParams>;
  }) => Promise<unknown>,
  searchParams: SearchParams,
): Promise<string> {
  redirectMock.mockClear();
  await expect(
    page({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve(searchParams),
    }),
  ).rejects.toThrow();
  return redirectMock.mock.calls[0][0];
}

describe("dashboard stub redirect", () => {
  it("redirects to /overview preserving scope and variant params", async () => {
    expect(await target(DashboardRedirect, { scope: "c2,c1", tz: "UTC" })).toBe(
      "/en/overview?scope=c2%2Cc1&tz=UTC",
    );
  });

  it("redirects to bare /overview with no query", async () => {
    expect(await target(DashboardRedirect, {})).toBe("/en/overview");
  });
});

describe("events stub redirect", () => {
  it("preserves scope: /events?scope=c1,c2 → /suspicious-events?scope=c1,c2", async () => {
    expect(await target(EventsRedirect, { scope: "c1,c2" })).toBe(
      "/en/suspicious-events?scope=c1%2Cc2",
    );
  });

  it("keeps report-variant params (tz/lang/model_name/model)", async () => {
    expect(
      await target(EventsRedirect, {
        tz: "Asia/Seoul",
        lang: "ENGLISH",
        model_name: "openai",
        model: "gpt-4o",
      }),
    ).toBe(
      "/en/suspicious-events?lang=ENGLISH&model=gpt-4o&model_name=openai&tz=Asia%2FSeoul",
    );
  });
});

describe("analysis stub redirect", () => {
  it("redirects to /overview preserving scope", async () => {
    expect(await target(AnalysisRedirect, { scope: "c3" })).toBe(
      "/en/overview?scope=c3",
    );
  });
});
