// scripts/release-zip.ts — a small deterministic zip writer for the
// windows-x64 release package (`sov-windows-x64.zip`).
//
// Why hand-rolled: the repo carries no zip dependency, a stock Windows shell
// has neither `tar` nor `zip`, and the release must build identically on a
// macOS/Linux laptop and a windows-latest runner. The writer is the plain
// PKZIP 2.0 layout — local headers + deflate streams, a central directory,
// and the end-of-central-directory record — which every extractor (Windows
// Explorer, `Expand-Archive`, `unzip`, `ditto`, Go's archive/zip) reads.
//
// Determinism: entries are sorted by forward-slash path, timestamps are the
// DOS epoch (1980-01-01), and modes are derived from the path (`bin/*` is
// executable) rather than from the host filesystem. Same input tree → same
// bytes, on any host.
//
// Not supported (and not needed here): zip64, encryption, directory entries
// for EMPTY directories (the release tree has none — `bundle-default/state/`
// carries a tracked `.gitkeep`). writeZip refuses inputs that would need
// zip64 instead of silently emitting a corrupt archive.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
/** "2.0" — the minimum version that understands method 8 (deflate). */
const VERSION_NEEDED = 20;
/** Host system 3 (UNIX) so extractors honour the mode in external attrs. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const METHOD_DEFLATE = 8;
/** DOS date 1980-01-01, DOS time 00:00:00 — the zip epoch. */
const DOS_EPOCH_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_EPOCH_TIME = 0;
const DEFLATE_LEVEL = 9;
const EXECUTABLE_MODE = 0o755;
const REGULAR_MODE = 0o644;
const EXECUTABLE_PREFIX = 'bin/';
/** Zip64 thresholds — beyond these the classic 16/32-bit fields overflow. */
export const MAX_ZIP_ENTRIES = 0xffff;
export const MAX_ZIP_BYTES = 0xffffffff;

export interface ZipEntry {
  /** Forward-slash path relative to the archive root, e.g. `bin/sov.exe`. */
  readonly path: string;
  readonly data: Uint8Array;
  /** POSIX mode stored in the central directory's external attributes. */
  readonly mode: number;
}

export type ZipLimitResult = { ok: true } | { ok: false; error: string };

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Mode is a function of the path only, so the archive does not depend on
 *  the host filesystem's notion of permissions (meaningless on Windows). */
export function zipModeFor(path: string): number {
  return path.startsWith(EXECUTABLE_PREFIX) ? EXECUTABLE_MODE : REGULAR_MODE;
}

/** Walk `rootDir` and return its files as sorted, forward-slash entries. */
export function collectZipEntries(rootDir: string): ZipEntry[] {
  const walk = (dir: string, prefix: string): ZipEntry[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) return walk(abs, rel);
      if (!dirent.isFile()) return [];
      return [{ path: rel, data: readFileSync(abs), mode: zipModeFor(rel) }];
    });
  return [...walk(rootDir, '')].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Refuse inputs that would overflow the classic zip fields (zip64 territory). */
export function assertZipLimits(
  entries: readonly Pick<ZipEntry, 'path' | 'data'>[],
): ZipLimitResult {
  if (entries.length > MAX_ZIP_ENTRIES) {
    return {
      ok: false,
      error: `zip: ${entries.length} entries exceeds ${MAX_ZIP_ENTRIES} (zip64 unsupported)`,
    };
  }
  const oversized = entries.find((e) => e.data.byteLength > MAX_ZIP_BYTES);
  if (oversized) {
    return { ok: false, error: `zip: ${oversized.path} exceeds 4 GiB (zip64 unsupported)` };
  }
  return { ok: true };
}

interface CompressedEntry {
  readonly entry: ZipEntry;
  readonly name: Buffer;
  readonly compressed: Buffer;
  readonly crc: number;
}

function compress(entry: ZipEntry): CompressedEntry {
  return {
    entry,
    name: Buffer.from(entry.path, 'utf8'),
    compressed: deflateRawSync(entry.data, { level: DEFLATE_LEVEL }),
    crc: crc32(entry.data),
  };
}

function localHeader(c: CompressedEntry): Buffer {
  const h = Buffer.alloc(LOCAL_HEADER_BYTES);
  h.writeUInt32LE(LOCAL_HEADER_SIG, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(0, 6); // general-purpose flags
  h.writeUInt16LE(METHOD_DEFLATE, 8);
  h.writeUInt16LE(DOS_EPOCH_TIME, 10);
  h.writeUInt16LE(DOS_EPOCH_DATE, 12);
  h.writeUInt32LE(c.crc, 14);
  h.writeUInt32LE(c.compressed.byteLength, 18);
  h.writeUInt32LE(c.entry.data.byteLength, 22);
  h.writeUInt16LE(c.name.byteLength, 26);
  h.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([h, c.name]);
}

function centralHeader(c: CompressedEntry, localOffset: number): Buffer {
  const h = Buffer.alloc(CENTRAL_HEADER_BYTES);
  h.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
  h.writeUInt16LE(VERSION_MADE_BY, 4);
  h.writeUInt16LE(VERSION_NEEDED, 6);
  h.writeUInt16LE(0, 8); // general-purpose flags
  h.writeUInt16LE(METHOD_DEFLATE, 10);
  h.writeUInt16LE(DOS_EPOCH_TIME, 12);
  h.writeUInt16LE(DOS_EPOCH_DATE, 14);
  h.writeUInt32LE(c.crc, 16);
  h.writeUInt32LE(c.compressed.byteLength, 20);
  h.writeUInt32LE(c.entry.data.byteLength, 24);
  h.writeUInt16LE(c.name.byteLength, 28);
  h.writeUInt16LE(0, 30); // extra field length
  h.writeUInt16LE(0, 32); // file comment length
  h.writeUInt16LE(0, 34); // disk number start
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(((0o100000 | c.entry.mode) << 16) >>> 0, 38); // S_IFREG | mode
  h.writeUInt32LE(localOffset, 42);
  return Buffer.concat([h, c.name]);
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const h = Buffer.alloc(EOCD_BYTES);
  h.writeUInt32LE(EOCD_SIG, 0);
  h.writeUInt16LE(0, 4); // this disk
  h.writeUInt16LE(0, 6); // disk with the central directory
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(0, 20); // comment length
  return h;
}

/** Serialise entries (in the order given) to a complete zip archive. */
export function buildZipBytes(entries: readonly ZipEntry[]): Buffer {
  const compressed = entries.map(compress);
  const locals = compressed.map((c) => Buffer.concat([localHeader(c), c.compressed]));
  const offsets = locals.reduce<number[]>(
    (acc, buf) => [...acc, (acc.at(-1) ?? 0) + buf.byteLength],
    [0],
  );
  const centrals = compressed.map((c, i) => centralHeader(c, offsets[i] as number));
  const cdOffset = offsets.at(-1) ?? 0;
  const cdSize = centrals.reduce((n, buf) => n + buf.byteLength, 0);
  return Buffer.concat([
    ...locals,
    ...centrals,
    endOfCentralDirectory(entries.length, cdSize, cdOffset),
  ]);
}

/** Zip the tree under `rootDir` (paths relative to it) to `outPath`. */
export function writeZip(outPath: string, rootDir: string): void {
  const entries = collectZipEntries(rootDir);
  const limits = assertZipLimits(entries);
  if (!limits.ok) throw new Error(limits.error);
  writeFileSync(outPath, buildZipBytes(entries));
}
