// RFC 0003 self-fetch streaming-decompress seams (#657) — pure unit tests.
//
// Covers the ZIP single-entry inflate and the line reader in isolation (no DB,
// no network), so the streaming/decompress primitives are verified in the unit
// suite. The full engine→staging→import path is covered in feed-fetch.db.test.ts.

import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openSingleZipEntry, readLines } from "../feed-fetch";

/** Minimal single-entry ZIP (local file header + DEFLATE data) — no central dir. */
function zipBytes(content: string, flags = 0, method = 8): Buffer {
  const body = Buffer.from(content, "utf8");
  const data = method === 8 ? deflateRawSync(body) : body;
  const name = Buffer.from("entry.txt", "utf8");
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(flags, 6);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(body.length, 22);
  lfh.writeUInt16LE(name.length, 26);
  return Buffer.concat([lfh, name, data]);
}

/** Drain a Readable to a single string. */
async function drain(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += (chunk as Buffer).toString("utf8");
  return out;
}

/** Collect an async iterable of lines. */
async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of gen) out.push(line);
  return out;
}

describe("openSingleZipEntry", () => {
  it("inflates the single DEFLATE entry, ignoring trailing bytes", async () => {
    const content = "line-1\nline-2\n".repeat(5000);
    // Append trailing bytes (mimicking a central directory) after the entry.
    const archive = Buffer.concat([
      zipBytes(content),
      Buffer.from("PK\x01\x02junk"),
    ]);
    const out = await drain(openSingleZipEntry(Readable.from([archive])));
    expect(out).toBe(content);
  });

  it("works when the archive is delivered in many small chunks", async () => {
    const content = "abcdef\nghijkl\n";
    const archive = zipBytes(content);
    // One byte per chunk forces the header to span pulls.
    const chunks = Array.from(archive, (b) => Buffer.from([b]));
    const out = await drain(openSingleZipEntry(Readable.from(chunks)));
    expect(out).toBe(content);
  });

  it("rejects a non-ZIP body", async () => {
    const stream = openSingleZipEntry(
      Readable.from([Buffer.from("definitely not a zip archive body padding")]),
    );
    await expect(drain(stream)).rejects.toThrow(/not a ZIP archive/);
  });

  it("rejects an encrypted entry", async () => {
    const stream = openSingleZipEntry(Readable.from([zipBytes("x\n", 0x1)]));
    await expect(drain(stream)).rejects.toThrow(/encrypted/);
  });

  it("rejects an unsupported (non-DEFLATE) compression method", async () => {
    const stream = openSingleZipEntry(Readable.from([zipBytes("x\n", 0, 0)]));
    await expect(drain(stream)).rejects.toThrow(/compression method/);
  });

  it("rejects a truncated header", async () => {
    const stream = openSingleZipEntry(Readable.from([Buffer.from("PK")]));
    await expect(drain(stream)).rejects.toThrow(/truncated/);
  });
});

describe("readLines", () => {
  it("splits on LF and CRLF, with no trailing newline required", async () => {
    const stream = Readable.from([Buffer.from("a\nb\r\nc")]);
    expect(await collect(readLines(stream))).toEqual(["a", "b", "c"]);
  });

  it("handles a line split across chunk boundaries", async () => {
    const stream = Readable.from([
      Buffer.from("hel"),
      Buffer.from("lo\nwor"),
      Buffer.from("ld\n"),
    ]);
    expect(await collect(readLines(stream))).toEqual(["hello", "world"]);
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const euro = Buffer.from("€", "utf8"); // 3 bytes
    const stream = Readable.from([
      euro.subarray(0, 1),
      euro.subarray(1),
      Buffer.from("\n"),
    ]);
    expect(await collect(readLines(stream))).toEqual(["€"]);
  });

  it("yields an empty list for an empty stream", async () => {
    expect(await collect(readLines(Readable.from([])))).toEqual([]);
  });
});
