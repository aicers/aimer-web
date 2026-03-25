import { describe, expect, it } from "vitest";
import { HttpError } from "../errors";

describe("HttpError", () => {
  it("carries statusCode and message", () => {
    const err = new HttpError("not found", 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe("not found");
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe("HttpError");
  });

  it("is distinguishable via instanceof from generic Error", () => {
    const generic = new Error("generic");
    const http = new HttpError("http", 400);

    expect(generic instanceof HttpError).toBe(false);
    expect(http instanceof HttpError).toBe(true);
    expect(http instanceof Error).toBe(true);
  });
});
