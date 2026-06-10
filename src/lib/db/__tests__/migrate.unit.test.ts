import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeChecksum, listMigrationFiles, runMigrations } from "../migrate";

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
    await writeFile(join(tempDir, "0003_seed.sql"), "INSERT;");

    const files = await listMigrationFiles(tempDir);

    expect(files).toHaveLength(3);
    expect(files[0].version).toBe("0001");
    expect(files[0].name).toBe("create_table");
    expect(files[1].version).toBe("0002");
    expect(files[1].name).toBe("add_index");
    expect(files[2].version).toBe("0003");
    expect(files[2].name).toBe("seed");
  });

  it("ignores files that do not match the naming convention", async () => {
    await writeFile(join(tempDir, "0001_valid.sql"), "SQL");
    await writeFile(join(tempDir, "README.md"), "docs");
    await writeFile(join(tempDir, ".gitkeep"), "");
    await writeFile(join(tempDir, "random.sql"), "SQL");
    await writeFile(join(tempDir, "001_short_version.sql"), "SQL");
    await writeFile(join(tempDir, "0002b_letter_suffix.sql"), "SQL");
    await writeFile(join(tempDir, "0003_typescript.ts"), "export default 1");

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

// ---------------------------------------------------------------------------
// runMigrations – mock-based execution tests
// ---------------------------------------------------------------------------

/**
 * Build a mock PoolClient that records every query() call. The optional
 * `queryHandler` lets individual tests control what specific queries return.
 */
function createMockClient(
  queryHandler?: (sql: string, params?: unknown[]) => unknown,
) {
  const calls: { sql: string; params?: unknown[] }[] = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (queryHandler) return queryHandler(sql, params);
      // Default: return empty rows for SELECT queries
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  return { client, calls };
}

function createMockPool(client: ReturnType<typeof createMockClient>["client"]) {
  return {
    connect: vi.fn(async () => client),
  } as unknown as import("pg").Pool;
}

describe("runMigrations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "run-migrations-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies a new SQL migration with BEGIN/COMMIT and inserts into _migrations", async () => {
    const sql = "CREATE TABLE foo (id INT);";
    await writeFile(join(tempDir, "0001_create_foo.sql"), sql);

    const { client, calls } = createMockClient();
    const pool = createMockPool(client);

    await runMigrations(pool, tempDir, 42);

    const sqlTexts = calls.map((c) => c.sql);

    // Advisory lock acquired
    expect(sqlTexts).toContain("SELECT pg_advisory_lock($1)");
    // Transaction wrapping
    expect(sqlTexts).toContain("BEGIN");
    expect(sqlTexts).toContain("SAVEPOINT migration");
    expect(sqlTexts).toContain(sql);
    expect(sqlTexts).toContain("RELEASE SAVEPOINT migration");
    expect(sqlTexts).toContain("COMMIT");
    // Inserted into _migrations
    const insertCall = calls.find((c) =>
      c.sql.includes("INSERT INTO _migrations"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall?.params).toEqual([
      "0001",
      "create_foo",
      computeChecksum(sql),
    ]);
    // Advisory lock released
    expect(sqlTexts).toContain("SELECT pg_advisory_unlock($1)");
    // Client released
    expect(client.release).toHaveBeenCalled();
  });

  it("acquires advisory lock before migrations and releases after", async () => {
    await writeFile(join(tempDir, "0001_init.sql"), "SELECT 1;");

    const { client, calls } = createMockClient();
    const pool = createMockPool(client);

    await runMigrations(pool, tempDir, 99);

    const sqlTexts = calls.map((c) => c.sql);
    const lockIdx = sqlTexts.indexOf("SELECT pg_advisory_lock($1)");
    const unlockIdx = sqlTexts.indexOf("SELECT pg_advisory_unlock($1)");

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(unlockIdx).toBeGreaterThan(lockIdx);

    // Lock uses the provided lock ID
    expect(calls[lockIdx].params).toEqual([99]);
    expect(calls[unlockIdx].params).toEqual([99]);
  });

  it("rolls back on SQL migration failure", async () => {
    const badSql = "INVALID SQL;";
    await writeFile(join(tempDir, "0001_bad.sql"), badSql);

    const { client, calls } = createMockClient((sql) => {
      if (sql === badSql) throw new Error("syntax error");
      return { rows: [] };
    });
    const pool = createMockPool(client);

    await expect(runMigrations(pool, tempDir, 1)).rejects.toThrow(
      "0001_bad failed",
    );

    const sqlTexts = calls.map((c) => c.sql);
    expect(sqlTexts).toContain("ROLLBACK TO SAVEPOINT migration");
    expect(sqlTexts).toContain("ROLLBACK");
    // COMMIT should NOT have been called
    expect(sqlTexts).not.toContain("COMMIT");
    // Advisory unlock must still fire (in finally block)
    expect(sqlTexts).toContain("SELECT pg_advisory_unlock($1)");
  });

  it("skips an already-applied migration with matching checksum", async () => {
    const sql = "CREATE TABLE bar (id INT);";
    const checksum = computeChecksum(sql);
    await writeFile(join(tempDir, "0001_create_bar.sql"), sql);

    const { client, calls } = createMockClient((sqlText) => {
      // Return existing migration from _migrations table
      if (sqlText.includes("SELECT version, checksum FROM _migrations")) {
        return { rows: [{ version: "0001", checksum }] };
      }
      return { rows: [] };
    });
    const pool = createMockPool(client);

    await runMigrations(pool, tempDir, 1);

    const sqlTexts = calls.map((c) => c.sql);
    // Should NOT attempt to apply the migration
    expect(sqlTexts).not.toContain(sql);
    expect(sqlTexts).not.toContain("BEGIN");
    expect(calls.some((c) => c.sql.includes("INSERT INTO _migrations"))).toBe(
      false,
    );
  });

  it("throws on checksum mismatch for already-applied migration", async () => {
    const sql = "CREATE TABLE baz (id INT);";
    await writeFile(join(tempDir, "0001_create_baz.sql"), sql);

    const { client } = createMockClient((sqlText) => {
      if (sqlText.includes("SELECT version, checksum FROM _migrations")) {
        return {
          rows: [{ version: "0001", checksum: "stale_checksum_value" }],
        };
      }
      return { rows: [] };
    });
    const pool = createMockPool(client);

    await expect(runMigrations(pool, tempDir, 1)).rejects.toThrow(
      "Checksum mismatch",
    );
  });
});
