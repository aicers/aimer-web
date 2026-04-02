import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, parseKvArgs } from "../cli-utils";

describe("log", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("outputs timestamped message", () => {
    log("hello");
    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*\] hello$/);
  });
});

describe("parseKvArgs", () => {
  const knownKeys = new Set(["target", "customer-id", "output-dir"]);
  const knownFlags = new Set(["dry-run", "confirm"]);

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("parses key=value arguments", () => {
    const result = parseKvArgs(
      ["--target=auth", "--customer-id=abc-123"],
      knownKeys,
      knownFlags,
    );
    expect(result.get("target")).toBe("auth");
    expect(result.get("customer-id")).toBe("abc-123");
  });

  it("parses boolean flags", () => {
    const result = parseKvArgs(
      ["--dry-run", "--confirm"],
      knownKeys,
      knownFlags,
    );
    expect(result.get("dry-run")).toBe("true");
    expect(result.get("confirm")).toBe("true");
  });

  it("handles mixed keys and flags", () => {
    const result = parseKvArgs(
      ["--target=full", "--dry-run"],
      knownKeys,
      knownFlags,
    );
    expect(result.get("target")).toBe("full");
    expect(result.has("dry-run")).toBe(true);
  });

  it("exits on unknown key=value arg", () => {
    expect(() => parseKvArgs(["--unknown=val"], knownKeys, knownFlags)).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorSpy).toHaveBeenCalledWith("Unknown flag: --unknown=val");
  });

  it("exits on unknown boolean flag", () => {
    expect(() => parseKvArgs(["--verbose"], knownKeys, knownFlags)).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("exits on positional argument", () => {
    expect(() => parseKvArgs(["somefile.txt"], knownKeys, knownFlags)).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("returns empty map for empty argv", () => {
    const result = parseKvArgs([], knownKeys, knownFlags);
    expect(result.size).toBe(0);
  });
});
