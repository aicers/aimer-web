import { Buffer } from "node:buffer";
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
const mockSignIn = vi.fn();
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

function createToken(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf-8")
      .toString("base64")
      .replace(/=+$/u, "")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  return `${header}.${body}.signature`;
}

test("signs in and navigates to /en/admin when role=administrator", async () => {
  mockRouter.push("/en/signin");
  mockSignIn.mockResolvedValueOnce({
    token: createToken({ role: "administrator" }),
  });

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
  await waitFor(() => expect(mockRouter.asPath).toBe("/en/admin"));
  expect(mockSignIn).toHaveBeenCalledWith({
    username: "user",
    password: "password123",
  });
});

test("signs in and navigates to /en/user when role=user", async () => {
  mockRouter.push("/en/signin");
  mockSignIn.mockResolvedValueOnce({
    token: createToken({ role: "user" }),
  });

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
  await waitFor(() => expect(mockRouter.asPath).toBe("/en/user"));
});

test("routes to the error screen when role is unsupported", async () => {
  mockRouter.push("/en/signin");
  mockSignIn.mockResolvedValueOnce({
    token: createToken({ role: "guest" }),
  });

  render(
    <NextIntlClientProvider messages={nestMessages(en)} locale="en">
      <LoginPage />
    </NextIntlClientProvider>,
  );
  fillAndSubmit("user", "password123");

  await waitFor(() => expect(mockRouter.asPath).toBe("/en/signin/error"));
  expect(global.fetch).not.toHaveBeenCalled();
});
