import { render, screen } from "@testing-library/react";
import HomePage from "../src/app/[locale]/page";
import "@testing-library/jest-dom";

// Mock next-intl
vi.mock("next-intl/server");
// Mock next/navigation
vi.mock("next/navigation");
// Mock LanguageSwitcher component
vi.mock("@/components/language-switcher", () => ({
  default: () => <button type="button">Language</button>,
}));

test("renders welcome message and buttons", async () => {
  const HomePageComponent = await HomePage({
    params: Promise.resolve({ locale: "en" }),
  });
  render(HomePageComponent);
  expect(screen.getByText("Welcome to Aimer Web")).toBeInTheDocument();
  expect(screen.getByText("User Sign In")).toBeInTheDocument();
  expect(screen.getByText("Admin Sign In")).toBeInTheDocument();
});
