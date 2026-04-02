import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupManifest } from "../storage";
import { LocalStorageBackend } from "../storage";

describe("LocalStorageBackend", () => {
  let tmpDir: string;
  let backend: LocalStorageBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "backup-test-"));
    backend = new LocalStorageBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("initBackupDir", () => {
    it("creates directory with customers/ and openbao/ subdirs", async () => {
      const dir = await backend.initBackupDir("2026-04-02T14-30-45Z");
      expect(existsSync(join(dir, "customers"))).toBe(true);
      expect(existsSync(join(dir, "openbao"))).toBe(true);
    });

    it("returns an absolute path", async () => {
      const dir = await backend.initBackupDir("test");
      expect(dir).toMatch(/^\//);
    });
  });

  describe("resolveBackupDir", () => {
    it("joins root with directory name", () => {
      const result = backend.resolveBackupDir("2026-04-02T14-30-45Z");
      expect(result).toBe(join(tmpDir, "2026-04-02T14-30-45Z"));
    });
  });

  describe("getAbsolutePath", () => {
    it("joins backup dir with relative path", () => {
      const result = backend.getAbsolutePath("/backups/abc", "auth_db.dump");
      expect(result).toBe("/backups/abc/auth_db.dump");
    });

    it("handles nested relative paths", () => {
      const result = backend.getAbsolutePath(
        "/backups/abc",
        "customers/customer_123.dump",
      );
      expect(result).toBe("/backups/abc/customers/customer_123.dump");
    });
  });

  describe("manifest read/write", () => {
    it("round-trips a manifest", async () => {
      const dir = await backend.initBackupDir("manifest-test");
      const manifest: BackupManifest = {
        version: 1,
        createdAt: "2026-04-02T14:30:45.000Z",
        label: null,
        targets: {
          auth_db: {
            file: "auth_db.dump",
            sizeBytes: 12345,
            durationMs: 200,
          },
        },
        skipped: [],
        errors: [],
      };

      await backend.writeManifest(dir, manifest);
      const loaded = await backend.readManifest(dir);

      expect(loaded).toEqual(manifest);
    });

    it("preserves customer metadata", async () => {
      const dir = await backend.initBackupDir("customer-manifest");
      const manifest: BackupManifest = {
        version: 1,
        createdAt: "2026-04-02T00:00:00.000Z",
        label: "test",
        targets: {
          customers: [
            {
              customerId: "abc-123",
              file: "customers/customer_abc123.dump",
              sizeBytes: 100,
              durationMs: 50,
            },
          ],
        },
        skipped: ["customer-def456"],
        errors: [{ target: "customer-ghi789", error: "db not found" }],
      };

      await backend.writeManifest(dir, manifest);
      const loaded = await backend.readManifest(dir);
      expect(loaded.targets.customers).toHaveLength(1);
      expect(loaded.targets.customers?.[0].customerId).toBe("abc-123");
      expect(loaded.skipped).toEqual(["customer-def456"]);
      expect(loaded.errors).toHaveLength(1);
    });
  });

  describe("listBackups", () => {
    it("returns directories sorted newest first", async () => {
      await backend.initBackupDir("2026-01-01T00-00-00Z");
      await backend.initBackupDir("2026-03-15T12-00-00Z");
      await backend.initBackupDir("2026-02-10T08-30-00Z");

      const list = await backend.listBackups();
      expect(list).toEqual([
        "2026-03-15T12-00-00Z",
        "2026-02-10T08-30-00Z",
        "2026-01-01T00-00-00Z",
      ]);
    });

    it("returns empty array when root does not exist", async () => {
      const absent = new LocalStorageBackend("/tmp/nonexistent-backup-dir");
      expect(await absent.listBackups()).toEqual([]);
    });

    it("ignores files (only lists directories)", async () => {
      await backend.initBackupDir("2026-01-01T00-00-00Z");
      await writeFile(join(tmpDir, "stray-file.txt"), "ignored");

      const list = await backend.listBackups();
      expect(list).toEqual(["2026-01-01T00-00-00Z"]);
    });
  });

  describe("deleteBackup", () => {
    it("removes the directory and its contents", async () => {
      const dir = await backend.initBackupDir("to-delete");
      await writeFile(join(dir, "auth_db.dump"), "fake dump");

      await backend.deleteBackup("to-delete");
      expect(existsSync(dir)).toBe(false);
    });

    it("does not throw when directory does not exist", async () => {
      await expect(backend.deleteBackup("nonexistent")).resolves.not.toThrow();
    });
  });
});
