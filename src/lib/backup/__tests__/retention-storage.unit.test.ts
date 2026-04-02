import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredBackups } from "../retention";
import type { BackupManifest } from "../storage";
import { LocalStorageBackend } from "../storage";

/**
 * Integration test: retention purge with real LocalStorageBackend
 * and manifest files on disk.
 */
describe("purgeExpiredBackups with LocalStorageBackend", () => {
  let tmpDir: string;
  let storage: LocalStorageBackend;

  const now = new Date("2026-04-02T00:00:00Z");

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "retention-int-"));
    storage = new LocalStorageBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createBackupWithManifest(
    dirName: string,
    manifest: BackupManifest,
  ) {
    const dir = await storage.initBackupDir(dirName);
    await storage.writeManifest(dir, manifest);
    return dir;
  }

  function authOnlyManifest(): BackupManifest {
    return {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      label: null,
      targets: {
        auth_db: { file: "auth_db.dump", sizeBytes: 100, durationMs: 10 },
      },
      skipped: [],
      errors: [],
    };
  }

  function auditManifest(): BackupManifest {
    return {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      label: null,
      targets: {
        audit_db: { file: "audit_db.dump", sizeBytes: 200, durationMs: 20 },
      },
      skipped: [],
      errors: [],
    };
  }

  function fullManifest(): BackupManifest {
    return {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      label: null,
      targets: {
        auth_db: { file: "auth_db.dump", sizeBytes: 100, durationMs: 10 },
        audit_db: { file: "audit_db.dump", sizeBytes: 200, durationMs: 20 },
      },
      skipped: [],
      errors: [],
    };
  }

  it("deletes old non-audit backups, retains old audit backups", async () => {
    // 60 days old auth-only → should be deleted (30-day retention)
    await createBackupWithManifest("2026-02-01T00-00-00Z", authOnlyManifest());

    // 60 days old audit → should be retained (365-day retention)
    await createBackupWithManifest("2026-02-01T12-00-00Z", auditManifest());

    const result = await purgeExpiredBackups(storage, 30, 365, now);

    expect(result.deleted).toEqual(["2026-02-01T00-00-00Z"]);
    expect(result.retained).toEqual(["2026-02-01T12-00-00Z"]);

    // Verify the deleted dir is actually gone from disk
    const remaining = await storage.listBackups();
    expect(remaining).toEqual(["2026-02-01T12-00-00Z"]);
  });

  it("retains full backups (with audit) under audit retention window", async () => {
    // 60 days old full backup (has audit) → audit retention applies
    await createBackupWithManifest("2026-02-01T00-00-00Z", fullManifest());

    const result = await purgeExpiredBackups(storage, 30, 365, now);

    expect(result.deleted).toEqual([]);
    expect(result.retained).toEqual(["2026-02-01T00-00-00Z"]);
  });

  it("deletes all types past their respective retention", async () => {
    // 400 days old audit → past audit retention (365)
    await createBackupWithManifest("2025-02-26T00-00-00Z", auditManifest());

    // 60 days old auth → past standard retention (30)
    await createBackupWithManifest("2026-02-01T00-00-00Z", authOnlyManifest());

    // 10 days old auth → within standard retention
    await createBackupWithManifest("2026-03-23T00-00-00Z", authOnlyManifest());

    const result = await purgeExpiredBackups(storage, 30, 365, now);

    expect(result.deleted).toContain("2025-02-26T00-00-00Z");
    expect(result.deleted).toContain("2026-02-01T00-00-00Z");
    expect(result.retained).toEqual(["2026-03-23T00-00-00Z"]);
  });

  it("falls back to standard retention when manifest is missing", async () => {
    // Create dir without manifest (just init, no writeManifest)
    await storage.initBackupDir("2026-02-01T00-00-00Z");

    const result = await purgeExpiredBackups(storage, 30, 365, now);

    // No manifest → can't determine if audit → uses standard 30 days → delete
    expect(result.deleted).toEqual(["2026-02-01T00-00-00Z"]);
  });
});
