import { fireEvent, render, screen, waitFor } from "@testing-library/react";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX in Vitest
import React from "react";
import "@testing-library/jest-dom";

// Mock Next.js navigation hooks with next-router-mock
vi.mock("next/navigation");

import mockRouter from "next-router-mock";

// Mock GraphQL signInRequest to avoid real network
const mockSignIn = vi.fn().mockResolvedValue({ token: "jwt-token" });
vi.mock("@/lib/graphql", () => ({
  signInRequest: (...args: unknown[]) => mockSignIn(...args),
}));

import LoginPage from "../src/app/signin/page";

function fillAndSubmit(id: string, pw: string) {
  const idInput = screen.getByPlaceholderText("ID");
  const pwInput = screen.getByPlaceholderText("Password");
  fireEvent.change(idInput, { target: { value: id } });
  fireEvent.change(pwInput, { target: { value: pw } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

test("signs in and navigates to /admin when mode=admin", async () => {
  mockRouter.push("/signin?mode=admin");

  render(<LoginPage />);
  fillAndSubmit("user", "password123");

  await waitFor(() =>
    expect(window.localStorage.getItem("aimer_token")).toBe("jwt-token"),
  );
  await waitFor(() => expect(mockRouter.asPath).toBe("/admin"));
  expect(mockSignIn).toHaveBeenCalledWith({
    username: "user",
    password: "password123",
  });
});

test("signs in and navigates to /user when mode=user (default)", async () => {
  mockRouter.push("/signin"); // no mode param → defaults to user

  render(<LoginPage />);
  fillAndSubmit("user", "password123");

  await waitFor(() =>
    expect(window.localStorage.getItem("aimer_token")).toBe("jwt-token"),
  );
  await waitFor(() => expect(mockRouter.asPath).toBe("/user"));
});
