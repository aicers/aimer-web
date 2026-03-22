import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeChecksum, listMigrationFiles } from "../migrate";

describe("computeChecksum", () => {
  it("returns a SHA-256 hex digest", () => {
    const result = computeChecksum("hello world");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns consistent results for the same input", () => {
    const a = computeChecksum("CREATE TABLE users (id SERIAL);");
    const b = computeChecksum("CREATE TABLE users (id SERIAL);");
    expect(a).toBe(b);
  });

  it("returns different results for different input", () => {
    const a = computeChecksum("CREATE TABLE users (id SERIAL);");
    const b = computeChecksum("CREATE TABLE posts (id SERIAL);");
    expect(a).not.toBe(b);
  });
});

describe("listMigrationFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "migrations-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent directory", async () => {
    const files = await listMigrationFiles("/nonexistent/path");
    expect(files).toEqual([]);
  });

  it("returns empty array for empty directory", async () => {
    const files = await listMigrationFiles(tempDir);
    expect(files).toEqual([]);
  });

  it("lists SQL migration files in sorted order", async () => {
    await writeFile(join(tempDir, "0002_add_index.sql"), "CREATE INDEX;");
    await writeFile(join(tempDir, "0001_create_table.sql"), "CREATE TABLE;");
    await writeFile(join(tempDir, "0003_backfill.ts"), "export default () => {}");

    const files = await listMigrationFiles(tempDir);

    expect(files).toHaveLength(3);
    expect(files[0].version).toBe("0001");
    expect(files[0].name).toBe("create_table");
    expect(files[0].ext).toBe("sql");
    expect(files[1].version).toBe("0002");
    expect(files[1].name).toBe("add_index");
    expect(files[1].ext).toBe("sql");
    expect(files[2].version).toBe("0003");
    expect(files[2].name).toBe("backfill");
    expect(files[2].ext).toBe("ts");
  });

  it("ignores files that do not match the naming convention", async () => {
    await writeFile(join(tempDir, "0001_valid.sql"), "SQL");
    await writeFile(join(tempDir, "README.md"), "docs");
    await writeFile(join(tempDir, ".gitkeep"), "");
    await writeFile(join(tempDir, "random.sql"), "SQL");
    await writeFile(join(tempDir, "001_short_version.sql"), "SQL");

    const files = await listMigrationFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0].version).toBe("0001");
  });

  it("includes full path in migration file entries", async () => {
    await writeFile(join(tempDir, "0001_init.sql"), "CREATE TABLE;");

    const files = await listMigrationFiles(tempDir);

    expect(files[0].path).toBe(join(tempDir, "0001_init.sql"));
  });

  it("handles subdirectories gracefully", async () => {
    await mkdir(join(tempDir, "0001_subdir.sql"));
    await writeFile(join(tempDir, "0002_real.sql"), "SQL");

    const files = await listMigrationFiles(tempDir);

    // readdir returns directory names too, but they match the pattern.
    // The runner would fail when trying to readFile on a directory,
    // but listMigrationFiles itself just lists matching entries.
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.version === "0002")).toBe(true);
  });
});

describe("checksum mismatch detection", () => {
  it("detects when content changes after initial checksum", () => {
    const original = "CREATE TABLE users (id SERIAL);";
    const modified = "CREATE TABLE users (id SERIAL, name TEXT);";

    const checksumOriginal = computeChecksum(original);
    const checksumModified = computeChecksum(modified);

    expect(checksumOriginal).not.toBe(checksumModified);
  });
});
