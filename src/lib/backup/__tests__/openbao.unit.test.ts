import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 8192 }),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  err: Error | null,
  stdout: string,
  stderr: string,
) => void;

function succeedExecFile() {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, cb?: unknown) => {
      if (typeof cb === "function") (cb as ExecFileCallback)(null, "", "");
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function failExecFile(message: string) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, cb?: unknown) => {
      if (typeof cb === "function")
        (cb as ExecFileCallback)(new Error(message), "", message);
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe("backupOpenBao", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockClear();
    succeedExecFile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls tar with correct arguments", async () => {
    const { backupOpenBao } = await import("../openbao");
    await backupOpenBao("/bao/data", "/backups/bao-data.tar.gz");

    expect(mockExecFile).toHaveBeenCalledWith(
      "tar",
      ["czf", "/backups/bao-data.tar.gz", "-C", "/bao", "data"],
      expect.any(Function),
    );
  });

  it("returns duration and size", async () => {
    const { backupOpenBao } = await import("../openbao");
    const result = await backupOpenBao("/bao/data", "/backups/bao-data.tar.gz");

    expect(result.sizeBytes).toBe(8192);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws on tar failure", async () => {
    failExecFile("permission denied");
    const { backupOpenBao } = await import("../openbao");

    await expect(
      backupOpenBao("/bao/data", "/backups/bao-data.tar.gz"),
    ).rejects.toThrow("OpenBao backup failed");
  });

  it("uses parent directory and basename from baoDataDir", async () => {
    const { backupOpenBao } = await import("../openbao");
    await backupOpenBao("/opt/openbao/file-data", "/backups/bao.tar.gz");

    expect(mockExecFile).toHaveBeenCalledWith(
      "tar",
      ["czf", "/backups/bao.tar.gz", "-C", "/opt/openbao", "file-data"],
      expect.any(Function),
    );
  });
});

describe("restoreOpenBao", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockClear();
    succeedExecFile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls tar extract with correct arguments", async () => {
    const { restoreOpenBao } = await import("../openbao");
    await restoreOpenBao("/backups/bao-data.tar.gz", "/bao/data");

    expect(mockExecFile).toHaveBeenCalledWith(
      "tar",
      ["xzf", "/backups/bao-data.tar.gz", "-C", "/bao"],
      expect.any(Function),
    );
  });

  it("returns duration", async () => {
    const { restoreOpenBao } = await import("../openbao");
    const result = await restoreOpenBao("/backups/bao.tar.gz", "/bao/data");

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws on tar failure", async () => {
    failExecFile("archive corrupted");
    const { restoreOpenBao } = await import("../openbao");

    await expect(
      restoreOpenBao("/backups/bao.tar.gz", "/bao/data"),
    ).rejects.toThrow("OpenBao restore failed");
  });

  it("removes existing data directory before extracting", async () => {
    const { rm } = await import("node:fs/promises");
    const { restoreOpenBao } = await import("../openbao");

    await restoreOpenBao("/backups/bao-data.tar.gz", "/bao/data");

    expect(rm).toHaveBeenCalledWith("/bao/data", {
      recursive: true,
      force: true,
    });
  });
});
