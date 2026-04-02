import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 4096 }),
}));

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  err: Error | null,
  stdout: string,
  stderr: string,
) => void;

// Helper: make mockExecFile succeed by calling the callback with no error
function succeedExecFile() {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, cb?: unknown) => {
      if (typeof cb === "function") (cb as ExecFileCallback)(null, "", "");
      return {} as ReturnType<typeof execFile>;
    },
  );
}

// Helper: make mockExecFile fail
function failExecFile(message: string) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, cb?: unknown) => {
      if (typeof cb === "function")
        (cb as ExecFileCallback)(new Error(message), "", message);
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe("pgDump", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockClear();
    succeedExecFile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls pg_dump with correct arguments", async () => {
    const { pgDump } = await import("../dump");
    await pgDump({
      connectionUrl: "postgres://u:p@localhost/testdb",
      outputPath: "/tmp/test.dump",
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "pg_dump",
      [
        "--format=custom",
        "--file=/tmp/test.dump",
        "postgres://u:p@localhost/testdb",
      ],
      expect.any(Function),
    );
  });

  it("returns duration and size on success", async () => {
    const { pgDump } = await import("../dump");
    const result = await pgDump({
      connectionUrl: "postgres://u:p@localhost/testdb",
      outputPath: "/tmp/test.dump",
    });

    expect(result.sizeBytes).toBe(4096);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws on pg_dump failure", async () => {
    failExecFile("connection refused");
    const { pgDump } = await import("../dump");

    await expect(
      pgDump({
        connectionUrl: "postgres://u:p@localhost/testdb",
        outputPath: "/tmp/test.dump",
      }),
    ).rejects.toThrow("pg_dump failed");
  });
});

describe("pgRestore", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockClear();
    succeedExecFile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls pg_restore with basic arguments", async () => {
    const { pgRestore } = await import("../dump");
    await pgRestore({
      connectionUrl: "postgres://u:p@localhost/testdb",
      inputPath: "/tmp/test.dump",
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "pg_restore",
      ["--dbname=postgres://u:p@localhost/testdb", "/tmp/test.dump"],
      expect.any(Function),
    );
  });

  it("includes --clean and --no-owner flags", async () => {
    const { pgRestore } = await import("../dump");
    await pgRestore({
      connectionUrl: "postgres://u:p@localhost/testdb",
      inputPath: "/tmp/test.dump",
      clean: true,
      noOwner: true,
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--clean");
    expect(args).toContain("--if-exists");
    expect(args).toContain("--no-owner");
  });

  it("throws on pg_restore failure", async () => {
    failExecFile("database does not exist");
    const { pgRestore } = await import("../dump");

    await expect(
      pgRestore({
        connectionUrl: "postgres://u:p@localhost/testdb",
        inputPath: "/tmp/test.dump",
      }),
    ).rejects.toThrow("pg_restore failed");
  });
});

describe("checkPgToolsAvailable", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockClear();
    succeedExecFile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when both tools are available", async () => {
    const { checkPgToolsAvailable } = await import("../dump");
    await expect(checkPgToolsAvailable()).resolves.not.toThrow();
  });

  it("throws when pg_dump is not found", async () => {
    mockExecFile.mockImplementation(
      (cmd: unknown, _args: unknown, cb?: unknown) => {
        if (cmd === "pg_dump") {
          if (typeof cb === "function")
            (cb as ExecFileCallback)(new Error("not found"), "", "");
        } else {
          if (typeof cb === "function") (cb as ExecFileCallback)(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const { checkPgToolsAvailable } = await import("../dump");
    await expect(checkPgToolsAvailable()).rejects.toThrow(
      "pg_dump is not available",
    );
  });
});
