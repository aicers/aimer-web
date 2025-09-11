import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { nestMessages } from "../src/i18n/messages";

// Mock Next.js navigation hooks with next-router-mock
vi.mock("next/navigation");

import mockRouter from "next-router-mock";

// Mock GraphQL signInRequest to avoid real network
const mockSignIn = vi.fn().mockResolvedValue({ token: "jwt-token" });
vi.mock("@/lib/graphql", () => ({
  signInRequest: (...args: unknown[]) => mockSignIn(...args),
}));

import LoginPage from "../src/app/[locale]/signin/page";

// Mock fetch used to set the HttpOnly cookie
beforeEach(() => {
  // mock global fetch for cookie API call without using `any`
  const mockFetch: typeof fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: mockFetch,
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  // Preserve mock implementations, only clear call history
  vi.clearAllMocks();
});

beforeEach(() => cleanup());
afterEach(() => cleanup());

function fillAndSubmit(id: string, pw: string) {
  const idInput = screen.getByPlaceholderText("ID");
  const pwInput = screen.getByPlaceholderText("Password");
  fireEvent.change(idInput, { target: { value: id } });
  fireEvent.change(pwInput, { target: { value: pw } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

test("signs in and navigates to /admin when mode=admin", async () => {
  mockRouter.push("/en/signin?mode=admin");

  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      <LoginPage />
    </NextIntlClientProvider>,
  );
  fillAndSubmit("user", "password123");

  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/set-cookie",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await waitFor(() => expect(mockRouter.asPath).toBe("/admin"));
  expect(mockSignIn).toHaveBeenCalledWith({
    username: "user",
    password: "password123",
  });
});

test("signs in and navigates to /user when mode=user (default)", async () => {
  mockRouter.push("/en/signin"); // no mode param → defaults to user

  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      <LoginPage />
    </NextIntlClientProvider>,
  );
  fillAndSubmit("user", "password123");

  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/set-cookie",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await waitFor(() => expect(mockRouter.asPath).toBe("/user"));
});
