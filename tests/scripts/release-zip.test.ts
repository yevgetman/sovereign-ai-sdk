import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  assertZipLimits,
  buildZipBytes,
  collectZipEntries,
  crc32,
  writeZip,
  zipModeFor,
} from '../../scripts/release-zip';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

type ParsedEntry = { path: string; data: Buffer; mode: number; crc: number };

/** A tiny reader for the writer's own output — enough to prove the layout
 *  is what every extractor expects, without shelling out to `unzip`. */
function parseZip(bytes: Buffer): ParsedEntry[] {
  const eocdOffset = bytes.byteLength - 22;
  expect(bytes.readUInt32LE(eocdOffset)).toBe(EOCD_SIG);
  const count = bytes.readUInt16LE(eocdOffset + 10);
  const cdOffset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ParsedEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(pos)).toBe(CENTRAL_SIG);
    const crc = bytes.readUInt32LE(pos + 16);
    const compressedLen = bytes.readUInt32LE(pos + 20);
    const nameLen = bytes.readUInt16LE(pos + 28);
    const mode = (bytes.readUInt32LE(pos + 38) >>> 16) & 0o777;
    const localOffset = bytes.readUInt32LE(pos + 42);
    const path = bytes.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    expect(bytes.readUInt32LE(localOffset)).toBe(LOCAL_SIG);
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const data = inflateRawSync(bytes.subarray(dataStart, dataStart + compressedLen));
    entries.push({ path, data: Buffer.from(data), mode, crc });
    pos += 46 + nameLen;
  }
  return entries;
}

function makeTree(root: string): void {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'bundle-default', 'state'), { recursive: true });
  writeFileSync(join(root, 'bin', 'sov.exe'), 'MZ sov');
  writeFileSync(join(root, 'bin', 'sov-tui.exe'), 'MZ tui');
  writeFileSync(join(root, 'bundle-default', 'index.yaml'), 'projectId: x\n');
  writeFileSync(join(root, 'bundle-default', 'state', '.gitkeep'), '');
  writeFileSync(join(root, 'version'), 'v0.7.0\n');
}

describe('release-zip — crc32', () => {
  test('matches the reference CRC-32 for a known string', () => {
    // crc32("hello world") = 0x0d4a1185
    expect(crc32(Buffer.from('hello world'))).toBe(0x0d4a1185);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('release-zip — zipModeFor', () => {
  test('bin/* is executable, everything else regular', () => {
    expect(zipModeFor('bin/sov.exe')).toBe(0o755);
    expect(zipModeFor('bin/sov-tui.exe')).toBe(0o755);
    expect(zipModeFor('version')).toBe(0o644);
    expect(zipModeFor('bundle-default/index.yaml')).toBe(0o644);
  });
});

describe('release-zip — collectZipEntries', () => {
  test('walks the tree into sorted forward-slash paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-zip-walk-'));
    try {
      makeTree(dir);
      const entries = collectZipEntries(dir);
      expect(entries.map((e) => e.path)).toEqual([
        'bin/sov-tui.exe',
        'bin/sov.exe',
        'bundle-default/index.yaml',
        'bundle-default/state/.gitkeep',
        'version',
      ]);
      expect(entries.every((e) => !e.path.includes('\\'))).toBe(true);
      expect(entries.find((e) => e.path === 'bin/sov.exe')?.mode).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release-zip — buildZipBytes', () => {
  test('round-trips every entry: names, bytes, crc, and mode', () => {
    const entries = [
      { path: 'bin/sov.exe', data: Buffer.from('MZ sov'), mode: 0o755 },
      { path: 'version', data: Buffer.from('v0.7.0\n'), mode: 0o644 },
      { path: 'empty', data: new Uint8Array(0), mode: 0o644 },
    ];
    const parsed = parseZip(buildZipBytes(entries));
    expect(parsed.map((e) => e.path)).toEqual(['bin/sov.exe', 'version', 'empty']);
    expect(parsed[0]?.data.toString()).toBe('MZ sov');
    expect(parsed[1]?.data.toString()).toBe('v0.7.0\n');
    expect(parsed[2]?.data.byteLength).toBe(0);
    expect(parsed[0]?.mode).toBe(0o755);
    expect(parsed[1]?.mode).toBe(0o644);
    expect(parsed[0]?.crc).toBe(crc32(Buffer.from('MZ sov')));
  });

  test('is deterministic: identical input yields identical bytes', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('same'), mode: 0o644 }];
    expect(buildZipBytes(entries).equals(buildZipBytes(entries))).toBe(true);
  });

  test('uses the DOS epoch timestamp, never the wall clock', () => {
    const bytes = buildZipBytes([{ path: 'a', data: Buffer.from('x'), mode: 0o644 }]);
    expect(bytes.readUInt16LE(10)).toBe(0); // local mod time
    expect(bytes.readUInt16LE(12)).toBe(0x0021); // local mod date = 1980-01-01
  });
});

describe('release-zip — assertZipLimits', () => {
  test('accepts a normal release tree', () => {
    expect(assertZipLimits([{ path: 'a', data: new Uint8Array(10) }])).toEqual({ ok: true });
  });

  test('rejects more than 65535 entries', () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      path: `f${i}`,
      data: new Uint8Array(0),
    }));
    const r = assertZipLimits(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('zip64');
  });

  test('rejects an entry at or beyond 4 GiB without allocating it', () => {
    const fake = { path: 'huge.bin', data: { byteLength: MAX_ZIP_BYTES + 1 } as Uint8Array };
    const r = assertZipLimits([fake]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('huge.bin');
  });
});

describe('release-zip — writeZip', () => {
  test('writes an archive whose entries mirror the source tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-zip-write-'));
    try {
      const tree = join(dir, 'stage');
      makeTree(tree);
      const out = join(dir, 'sov-windows-x64.zip');
      writeZip(out, tree);
      const parsed = parseZip(readFileSync(out));
      expect(parsed.map((e) => e.path)).toEqual([
        'bin/sov-tui.exe',
        'bin/sov.exe',
        'bundle-default/index.yaml',
        'bundle-default/state/.gitkeep',
        'version',
      ]);
      expect(parsed.find((e) => e.path === 'version')?.data.toString()).toBe('v0.7.0\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('produces byte-identical archives across two runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-zip-det-'));
    try {
      const tree = join(dir, 'stage');
      makeTree(tree);
      writeZip(join(dir, 'one.zip'), tree);
      writeZip(join(dir, 'two.zip'), tree);
      expect(readFileSync(join(dir, 'one.zip')).equals(readFileSync(join(dir, 'two.zip')))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
