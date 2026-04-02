import { describe, expect, it, vi } from "vitest";
import { purgeExpiredBackups } from "../retention";
import type { BackupManifest, StorageBackend } from "../storage";

function makeManifest(hasAudit: boolean, hasAuth = false): BackupManifest {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    label: null,
    targets: {
      ...(hasAuth
        ? { auth_db: { file: "auth_db.dump", sizeBytes: 100, durationMs: 10 } }
        : {}),
      ...(hasAudit
        ? {
            audit_db: { file: "audit_db.dump", sizeBytes: 100, durationMs: 10 },
          }
        : {}),
    },
    skipped: [],
    errors: [],
  };
}

function makeMockStorage(
  dirs: string[],
  manifests?: Record<string, BackupManifest>,
): StorageBackend {
  return {
    listBackups: vi.fn().mockResolvedValue(dirs),
    deleteBackup: vi.fn().mockResolvedValue(undefined),
    initBackupDir: vi.fn(),
    resolveBackupDir: vi
      .fn()
      .mockImplementation((dir: string) => `/backups/${dir}`),
    getAbsolutePath: vi.fn(),
    writeManifest: vi.fn(),
    readManifest: vi.fn().mockImplementation(async (path: string) => {
      // Extract dir name from path like /backups/2026-01-01T00-00-00Z
      const dirName = path.split("/").pop() ?? "";
      if (manifests?.[dirName]) return manifests[dirName];
      throw new Error("not found");
    }),
  };
}

describe("purgeExpiredBackups", () => {
  // Reference time: 2026-04-02
  const now = new Date("2026-04-02T00:00:00Z");

  it("deletes backups older than retention window", async () => {
    const storage = makeMockStorage([
      "2026-04-01T00-00-00Z", // 1 day old — keep
      "2026-02-15T00-00-00Z", // ~46 days old — delete
      "2026-01-01T00-00-00Z", // 91 days old — delete
    ]);

    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual([
      "2026-02-15T00-00-00Z",
      "2026-01-01T00-00-00Z",
    ]);
    expect(result.retained).toEqual(["2026-04-01T00-00-00Z"]);
  });

  it("retains all backups when none are expired", async () => {
    const storage = makeMockStorage([
      "2026-04-01T12-00-00Z",
      "2026-03-30T08-00-00Z",
    ]);

    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual([]);
    expect(result.retained).toHaveLength(2);
  });

  it("handles empty backup list", async () => {
    const storage = makeMockStorage([]);
    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual([]);
    expect(result.retained).toEqual([]);
  });

  it("retains directories with unrecognized names", async () => {
    const storage = makeMockStorage([
      "2026-01-01T00-00-00Z", // expired
      "random-dir", // unrecognized — keep
    ]);

    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual(["2026-01-01T00-00-00Z"]);
    expect(result.retained).toEqual(["random-dir"]);
  });

  it("handles labeled backups correctly", async () => {
    const storage = makeMockStorage([
      "2026-01-15T00-00-00Z_pre-delete-abc", // expired
      "2026-03-20T00-00-00Z_pre-delete-def", // within window
    ]);

    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual(["2026-01-15T00-00-00Z_pre-delete-abc"]);
    expect(result.retained).toEqual(["2026-03-20T00-00-00Z_pre-delete-def"]);
  });

  it("retains backups at exact cutoff boundary, deletes older", async () => {
    // 30 days before now = 2026-03-03T00:00:00Z
    const storage = makeMockStorage([
      "2026-03-03T00-00-00Z", // exactly at cutoff — retain (not < cutoff)
      "2026-03-02T23-59-59Z", // 1 second before cutoff — delete
    ]);

    const result = await purgeExpiredBackups(storage, 30, 30, now);
    expect(result.deleted).toEqual(["2026-03-02T23-59-59Z"]);
    expect(result.retained).toEqual(["2026-03-03T00-00-00Z"]);
  });

  describe("audit retention", () => {
    it("uses longer audit retention for backups with audit_db", async () => {
      // Standard cutoff: 30 days → 2026-03-03
      // Audit cutoff: 365 days → 2025-04-02
      // Backup from 2025-06-01 is older than 30 days but within 365 days
      const manifests: Record<string, BackupManifest> = {
        "2025-06-01T00-00-00Z": makeManifest(true), // has audit_db
      };
      const storage = makeMockStorage(["2025-06-01T00-00-00Z"], manifests);

      const result = await purgeExpiredBackups(storage, 30, 365, now);
      // Should be retained because audit retention is 365 days
      expect(result.retained).toEqual(["2025-06-01T00-00-00Z"]);
      expect(result.deleted).toEqual([]);
    });

    it("uses standard retention for backups without audit_db", async () => {
      // Backup from 60 days ago, no audit data
      const manifests: Record<string, BackupManifest> = {
        "2026-02-01T00-00-00Z": makeManifest(false, true), // auth only
      };
      const storage = makeMockStorage(["2026-02-01T00-00-00Z"], manifests);

      const result = await purgeExpiredBackups(storage, 30, 365, now);
      // Should be deleted because standard retention is 30 days
      expect(result.deleted).toEqual(["2026-02-01T00-00-00Z"]);
    });

    it("skips manifest read when audit and standard retention are equal", async () => {
      const storage = makeMockStorage(["2026-01-01T00-00-00Z"]);

      await purgeExpiredBackups(storage, 30, 30, now);
      // readManifest should not be called when retentions are equal
      expect(storage.readManifest).not.toHaveBeenCalled();
    });

    it("falls back to standard retention when manifest is unreadable", async () => {
      // No manifests provided → readManifest will throw → fallback
      const storage = makeMockStorage(["2026-02-01T00-00-00Z"]);

      const result = await purgeExpiredBackups(storage, 30, 365, now);
      // 60 days old, standard retention 30 days → delete
      expect(result.deleted).toEqual(["2026-02-01T00-00-00Z"]);
    });

    it("deletes audit backup past audit retention", async () => {
      // Audit cutoff: 365 days → 2025-04-02
      // Backup from 2025-03-01 is older than 365 days
      const manifests: Record<string, BackupManifest> = {
        "2025-03-01T00-00-00Z": makeManifest(true),
      };
      const storage = makeMockStorage(["2025-03-01T00-00-00Z"], manifests);

      const result = await purgeExpiredBackups(storage, 30, 365, now);
      expect(result.deleted).toEqual(["2025-03-01T00-00-00Z"]);
    });
  });
});
