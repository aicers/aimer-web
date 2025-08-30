import { render, screen } from "@testing-library/react";
import HomePage from "../src/app/page";
import "@testing-library/jest-dom";

// useRouter mocking
vi.mock("next/navigation");

test("renders welcome message and buttons", () => {
  render(<HomePage />);
  expect(screen.getByText("Welcome to Aimer Web")).toBeInTheDocument();
  expect(screen.getByText("User Sign In")).toBeInTheDocument();
  expect(screen.getByText("Admin Sign In")).toBeInTheDocument();
});
