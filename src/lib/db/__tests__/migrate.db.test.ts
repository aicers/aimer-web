import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "./db-test-helpers";

describe.skipIf(!hasPostgres)(
  "Migration runner (PostgreSQL integration)",
  () => {
    let dbName: string;
    let pool: Pool;
    let tempDir: string;
    const LOCK_ID = 99999;

    beforeAll(async () => {
      const db = await createTestDatabase("migrate");
      dbName = db.dbName;
      pool = db.pool;
    });

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
      await closeAdminPool();
    });

    beforeEach(async () => {
      // Reset: drop _migrations and any test tables
      const client = await pool.connect();
      try {
        await client.query("DROP TABLE IF EXISTS _migrations CASCADE");
        await client.query("DROP TABLE IF EXISTS test_table CASCADE");
        await client.query("DROP TABLE IF EXISTS t1 CASCADE");
        await client.query("DROP TABLE IF EXISTS t2 CASCADE");
        await client.query("DROP TABLE IF EXISTS t3 CASCADE");
        await client.query("DROP TABLE IF EXISTS t4 CASCADE");
        await client.query("DROP TABLE IF EXISTS t5 CASCADE");
        await client.query("DROP TABLE IF EXISTS ts_test CASCADE");
      } finally {
        client.release();
      }
      // Fresh temp directory for migration files
      tempDir = await mkdtemp(join(tmpdir(), "db-migrate-"));
    });

    it("auto-creates _migrations table (idempotent)", async () => {
      // First run: table doesn't exist yet
      await runMigrations(pool, tempDir, LOCK_ID);
      const { rows: r1 } = await pool.query(
        "SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = '_migrations')",
      );
      expect(r1[0].exists).toBe(true);

      // Second run: table already exists, no error
      await runMigrations(pool, tempDir, LOCK_ID);
      const { rows: r2 } = await pool.query("SELECT COUNT(*) FROM _migrations");
      expect(Number(r2[0].count)).toBe(0);
    });

    it("advisory lock prevents concurrent runners from duplicating migrations", async () => {
      // Create a slow migration using pg_sleep
      await writeFile(
        join(tempDir, "0001_slow.sql"),
        "SELECT pg_sleep(0.5); CREATE TABLE test_table (id int);",
      );

      // Launch two runners concurrently
      const [r1, r2] = await Promise.allSettled([
        runMigrations(pool, tempDir, LOCK_ID),
        runMigrations(pool, tempDir, LOCK_ID),
      ]);

      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");

      // Migration should be applied exactly once
      const { rows } = await pool.query(
        "SELECT COUNT(*) FROM _migrations WHERE version = '0001'",
      );
      expect(Number(rows[0].count)).toBe(1);

      // Table should exist
      const { rows: tables } = await pool.query(
        "SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = 'test_table')",
      );
      expect(tables[0].exists).toBe(true);
    });

    it("no-transaction migration with CREATE INDEX CONCURRENTLY", async () => {
      // First migration creates a table
      await writeFile(
        join(tempDir, "0001_create.sql"),
        "CREATE TABLE test_table (id int, name text);",
      );
      await runMigrations(pool, tempDir, LOCK_ID);

      // Add a no-transaction migration
      await writeFile(
        join(tempDir, "0002_index.sql"),
        "-- no-transaction\nCREATE INDEX CONCURRENTLY idx_test_name ON test_table (name);",
      );
      await runMigrations(pool, tempDir, LOCK_ID);

      // Verify index exists
      const { rows } = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'test_table' AND indexname = 'idx_test_name'",
      );
      expect(rows).toHaveLength(1);
    });

    it("rolls back failed migration without affecting prior successes", async () => {
      await writeFile(
        join(tempDir, "0001_ok.sql"),
        "CREATE TABLE test_table (id serial PRIMARY KEY);",
      );
      await writeFile(
        join(tempDir, "0002_fail.sql"),
        "CREATE TABLE nonexistent_ref (id int REFERENCES does_not_exist(id));",
      );

      await expect(runMigrations(pool, tempDir, LOCK_ID)).rejects.toThrow(
        "0002_fail",
      );

      // Migration 1 should be committed
      const { rows: applied } = await pool.query(
        "SELECT version FROM _migrations",
      );
      expect(applied.map((r) => r.version)).toEqual(["0001"]);

      // Table from migration 1 should exist
      const { rows: tables } = await pool.query(
        "SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = 'test_table')",
      );
      expect(tables[0].exists).toBe(true);
    });

    it("detects checksum mismatch for modified migration", async () => {
      await writeFile(
        join(tempDir, "0001_init.sql"),
        "CREATE TABLE test_table (id int);",
      );
      await runMigrations(pool, tempDir, LOCK_ID);

      // Modify the file
      await writeFile(
        join(tempDir, "0001_init.sql"),
        "CREATE TABLE test_table (id int, extra text);",
      );

      await expect(runMigrations(pool, tempDir, LOCK_ID)).rejects.toThrow(
        "Checksum mismatch",
      );
    });

    it("commits migrations 1-2, fails on 3, skips 4-5", async () => {
      await writeFile(
        join(tempDir, "0001_t1.sql"),
        "CREATE TABLE t1 (id int);",
      );
      await writeFile(
        join(tempDir, "0002_t2.sql"),
        "CREATE TABLE t2 (id int);",
      );
      await writeFile(join(tempDir, "0003_t3.sql"), "INVALID SQL STATEMENT;");
      await writeFile(
        join(tempDir, "0004_t4.sql"),
        "CREATE TABLE t4 (id int);",
      );
      await writeFile(
        join(tempDir, "0005_t5.sql"),
        "CREATE TABLE t5 (id int);",
      );

      await expect(runMigrations(pool, tempDir, LOCK_ID)).rejects.toThrow(
        "0003_t3",
      );

      // Only 1-2 recorded
      const { rows: applied } = await pool.query(
        "SELECT version FROM _migrations ORDER BY version",
      );
      expect(applied.map((r) => r.version)).toEqual(["0001", "0002"]);

      // t1, t2 exist; t3, t4, t5 don't
      for (const [table, expected] of [
        ["t1", true],
        ["t2", true],
        ["t3", false],
        ["t4", false],
        ["t5", false],
      ] as const) {
        const { rows } = await pool.query(
          `SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = '${table}')`,
        );
        expect(rows[0].exists).toBe(expected);
      }
    });

    it("executes TypeScript migration with default export function", async () => {
      // Create the target table first
      await writeFile(
        join(tempDir, "0001_setup.sql"),
        "CREATE TABLE ts_test (id serial PRIMARY KEY, value text);",
      );

      // Create a .ts migration that inserts a row
      await writeFile(
        join(tempDir, "0002_seed.ts"),
        `export default async function(client) {
          await client.query("INSERT INTO ts_test (value) VALUES ('hello')");
        }`,
      );

      await runMigrations(pool, tempDir, LOCK_ID);

      // Verify the row was inserted
      const { rows } = await pool.query("SELECT value FROM ts_test");
      expect(rows).toEqual([{ value: "hello" }]);

      // Verify both migrations recorded
      const { rows: applied } = await pool.query(
        "SELECT version FROM _migrations ORDER BY version",
      );
      expect(applied.map((r) => r.version)).toEqual(["0001", "0002"]);
    });

    it("rejects TypeScript migration without default function export", async () => {
      await writeFile(
        join(tempDir, "0001_bad.ts"),
        'export default "not a function";',
      );

      await expect(runMigrations(pool, tempDir, LOCK_ID)).rejects.toThrow(
        "must export a default function",
      );
    });

    it("passes MigrationContext to TypeScript migration", async () => {
      // Create a table to store the context proof
      await writeFile(
        join(tempDir, "0001_setup.sql"),
        "CREATE TABLE ts_test (id serial PRIMARY KEY, value text);",
      );

      // Migration that uses context
      await writeFile(
        join(tempDir, "0002_ctx.ts"),
        `export default async function(client, context) {
          const val = context?.decryptDek ? "has_context" : "no_context";
          await client.query("INSERT INTO ts_test (value) VALUES ($1)", [val]);
        }`,
      );

      const mockContext = {
        decryptDek: async () => Buffer.from("test"),
      };

      await runMigrations(pool, tempDir, LOCK_ID, mockContext);

      const { rows } = await pool.query("SELECT value FROM ts_test");
      expect(rows[0].value).toBe("has_context");
    });
  },
);
