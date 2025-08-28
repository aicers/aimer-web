import { render, screen } from "@testing-library/react";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX in Vitest
import React from "react";
import AdminAppPage from "../src/app/admin/page";
import "@testing-library/jest-dom";

test("renders admin app page", () => {
  render(<AdminAppPage />);
  expect(screen.getByText("Admin App")).toBeInTheDocument();
});
