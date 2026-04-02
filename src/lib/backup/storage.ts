import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export interface BackupTargetMeta {
  file: string;
  sizeBytes: number;
  durationMs: number;
}

export interface CustomerBackupMeta extends BackupTargetMeta {
  customerId: string;
  skipped?: boolean;
}

export interface BackupManifest {
  version: number;
  createdAt: string;
  label: string | null;
  targets: {
    auth_db?: BackupTargetMeta;
    audit_db?: BackupTargetMeta;
    customers?: CustomerBackupMeta[];
    openbao?: BackupTargetMeta;
  };
  skipped: string[];
  errors: Array<{ target: string; error: string }>;
}

// ---------------------------------------------------------------------------
// StorageBackend interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  /** Create the backup directory structure. Returns the absolute root path. */
  initBackupDir(dirName: string): Promise<string>;

  /** Resolve a directory name (as returned by listBackups) to a full path. */
  resolveBackupDir(dirName: string): string;

  /** Return the absolute path for a file inside a backup directory. */
  getAbsolutePath(backupDir: string, relativePath: string): string;

  /** Write the manifest to a backup directory. */
  writeManifest(backupDir: string, manifest: BackupManifest): Promise<void>;

  /** Read the manifest from a backup directory. */
  readManifest(backupDir: string): Promise<BackupManifest>;

  /** List all backup directory names, sorted newest first. */
  listBackups(): Promise<string[]>;

  /** Delete a backup directory and all its contents. */
  deleteBackup(dirName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local filesystem implementation
// ---------------------------------------------------------------------------

export class LocalStorageBackend implements StorageBackend {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async initBackupDir(dirName: string): Promise<string> {
    const dir = join(this.rootDir, dirName);
    await mkdir(join(dir, "customers"), { recursive: true });
    await mkdir(join(dir, "openbao"), { recursive: true });
    return dir;
  }

  resolveBackupDir(dirName: string): string {
    return join(this.rootDir, dirName);
  }

  getAbsolutePath(backupDir: string, relativePath: string): string {
    return join(backupDir, relativePath);
  }

  async writeManifest(
    backupDir: string,
    manifest: BackupManifest,
  ): Promise<void> {
    const path = join(backupDir, "manifest.json");
    await writeFile(path, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async readManifest(backupDir: string): Promise<BackupManifest> {
    const path = join(backupDir, "manifest.json");
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as BackupManifest;
  }

  async listBackups(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }

    const dirs: string[] = [];
    for (const entry of entries) {
      const entryPath = join(this.rootDir, entry);
      const s = await stat(entryPath).catch(() => null);
      if (s?.isDirectory()) {
        dirs.push(entry);
      }
    }

    return dirs.sort().reverse();
  }

  async deleteBackup(dirName: string): Promise<void> {
    const dir = join(this.rootDir, dirName);
    await rm(dir, { recursive: true, force: true });
  }
}
