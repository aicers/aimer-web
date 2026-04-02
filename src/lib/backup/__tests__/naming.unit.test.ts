import { describe, expect, it } from "vitest";
import {
  backupDirName,
  customerDumpFileName,
  dbDumpFileName,
  openbaoDumpFileName,
  parseBackupDirName,
} from "../naming";

describe("backupDirName", () => {
  it("formats a UTC timestamp without label", () => {
    const date = new Date("2026-04-02T14:30:45.123Z");
    expect(backupDirName(date)).toBe("2026-04-02T14-30-45Z");
  });

  it("appends a sanitized label", () => {
    const date = new Date("2026-04-02T14:30:45.000Z");
    expect(backupDirName(date, "pre-delete")).toBe(
      "2026-04-02T14-30-45Z_pre-delete",
    );
  });

  it("sanitizes special characters in label", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(backupDirName(date, "my label/with:stuff")).toBe(
      "2026-01-01T00-00-00Z_my-label-with-stuff",
    );
  });

  it("truncates label to 64 characters", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const longLabel = "a".repeat(100);
    const result = backupDirName(date, longLabel);
    // timestamp(20) + _ + 64 = 85
    expect(result.length).toBe(85);
  });
});

describe("parseBackupDirName", () => {
  it("parses a timestamp-only directory name", () => {
    const result = parseBackupDirName("2026-04-02T14-30-45Z");
    expect(result).not.toBeNull();
    expect(result?.date.toISOString()).toBe("2026-04-02T14:30:45.000Z");
    expect(result?.label).toBeUndefined();
  });

  it("parses a directory name with label", () => {
    const result = parseBackupDirName("2026-04-02T14-30-45Z_pre-delete");
    expect(result).not.toBeNull();
    expect(result?.date.toISOString()).toBe("2026-04-02T14:30:45.000Z");
    expect(result?.label).toBe("pre-delete");
  });

  it("returns null for invalid format", () => {
    expect(parseBackupDirName("not-a-backup")).toBeNull();
    expect(parseBackupDirName("")).toBeNull();
    expect(parseBackupDirName("2026-04-02")).toBeNull();
  });

  it("round-trips with backupDirName", () => {
    const date = new Date("2026-06-15T09:00:00.000Z");
    const dirName = backupDirName(date, "test-label");
    const parsed = parseBackupDirName(dirName);
    expect(parsed).not.toBeNull();
    expect(parsed?.date.toISOString()).toBe(date.toISOString());
    expect(parsed?.label).toBe("test-label");
  });
});

describe("dbDumpFileName", () => {
  it("returns auth_db.dump for auth", () => {
    expect(dbDumpFileName("auth")).toBe("auth_db.dump");
  });

  it("returns audit_db.dump for audit", () => {
    expect(dbDumpFileName("audit")).toBe("audit_db.dump");
  });
});

describe("customerDumpFileName", () => {
  it("strips hyphens from UUID", () => {
    expect(customerDumpFileName("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "customer_a1b2c3d4e5f67890abcdef1234567890.dump",
    );
  });
});

describe("openbaoDumpFileName", () => {
  it("returns the fixed filename", () => {
    expect(openbaoDumpFileName()).toBe("bao-data.tar.gz");
  });
});
