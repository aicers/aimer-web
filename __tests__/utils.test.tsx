import { describe, expect, test } from "vitest";
import { friendlyError } from "../src/lib/utils";

describe("friendlyError", () => {
  test("returns GraphQL error.message when present", () => {
    const err = {
      response: { errors: [{ message: "Incorrect username or password" }] },
    };
    expect(friendlyError(err)).toBe("Incorrect username or password");
  });

  test("falls back to Error.message", () => {
    const err = new Error("Something went wrong");
    expect(friendlyError(err)).toBe("Something went wrong");
  });

  test("accepts string errors", () => {
    expect(friendlyError("Plain message")).toBe("Plain message");
  });

  test("returns fallback for unknown shapes", () => {
    expect(friendlyError(1234, "Failed")).toBe("Failed");
  });
});
