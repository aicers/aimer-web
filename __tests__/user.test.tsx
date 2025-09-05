import { render, screen } from "@testing-library/react";
import UserAppPage from "../src/app/[locale]/user/page";
import "@testing-library/jest-dom";

// Mock next-intl/server
vi.mock("next-intl/server");
// Mock LanguageSwitcher component
vi.mock("@/components/language-switcher", () => ({
  default: () => <button type="button">Language</button>,
}));

test("renders user app page", async () => {
  const UserAppPageComponent = await UserAppPage();
  render(UserAppPageComponent);
  expect(screen.getByText("User App")).toBeInTheDocument();
});
