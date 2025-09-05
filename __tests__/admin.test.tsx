import { render, screen } from "@testing-library/react";
import AdminAppPage from "../src/app/[locale]/admin/page";
import "@testing-library/jest-dom";

// Mock next-intl/server
vi.mock("next-intl/server");
// Mock LanguageSwitcher component
vi.mock("@/components/language-switcher", () => ({
  default: () => <button type="button">Language</button>,
}));

test("renders admin app page", async () => {
  const AdminAppPageComponent = await AdminAppPage();
  render(AdminAppPageComponent);
  expect(screen.getByText("Admin App")).toBeInTheDocument();
});
