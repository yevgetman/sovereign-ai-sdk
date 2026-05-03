// File I/O round-trips for inputHistory. Uses temp files so the
// real ~/.harness/input-history is untouched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputHistory } from '../../src/ui/inputHistory.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sov-history-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('InputHistory.load', () => {
  test('returns empty when file is missing', () => {
    const h = new InputHistory({ path: join(dir, 'nope') });
    h.load();
    expect(h.snapshot()).toEqual([]);
    expect(h.size()).toBe(0);
  });

  test('reads existing entries, oldest first', () => {
    const path = join(dir, 'h');
    writeFileSync(path, 'first\nsecond\nthird\n');
    const h = new InputHistory({ path });
    h.load();
    expect(h.snapshot()).toEqual(['first', 'second', 'third']);
  });

  test('decodes \\n placeholders back to real newlines', () => {
    const path = join(dir, 'h');
    writeFileSync(path, 'multi\\nline\nplain\n');
    const h = new InputHistory({ path });
    h.load();
    expect(h.snapshot()).toEqual(['multi\nline', 'plain']);
  });
});

describe('InputHistory.add', () => {
  test('appends and persists', () => {
    const path = join(dir, 'h');
    const h = new InputHistory({ path });
    h.load();
    h.add('hello');
    h.add('world');
    expect(h.snapshot()).toEqual(['hello', 'world']);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hello\nworld\n');
  });

  test('skips empty / whitespace-only entries', () => {
    const h = new InputHistory({ path: join(dir, 'h') });
    h.load();
    h.add('');
    h.add('   ');
    h.add('\t\n');
    expect(h.size()).toBe(0);
  });

  test('skips exact duplicate of previous', () => {
    const h = new InputHistory({ path: join(dir, 'h') });
    h.load();
    h.add('a');
    h.add('a');
    h.add('b');
    h.add('a');
    expect(h.snapshot()).toEqual(['a', 'b', 'a']);
  });

  test('encodes embedded newlines so the file stays one-entry-per-line', () => {
    const path = join(dir, 'h');
    const h = new InputHistory({ path });
    h.load();
    h.add('multi\nline');
    h.add('plain');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toBe('multi\\nline\nplain\n');
  });

  test('caps at maxEntries and rotates oldest first', () => {
    const path = join(dir, 'h');
    const h = new InputHistory({ path, maxEntries: 3 });
    h.load();
    h.add('a');
    h.add('b');
    h.add('c');
    h.add('d');
    expect(h.snapshot()).toEqual(['b', 'c', 'd']);
  });
});

describe('InputHistory.at', () => {
  test('0 → most recent, increasing offsets walk back in time', () => {
    const h = new InputHistory({ path: join(dir, 'h') });
    h.load();
    h.add('one');
    h.add('two');
    h.add('three');
    expect(h.at(0)).toBe('three');
    expect(h.at(1)).toBe('two');
    expect(h.at(2)).toBe('one');
    expect(h.at(3)).toBeUndefined();
  });

  test('negative offset is undefined', () => {
    const h = new InputHistory({ path: join(dir, 'h') });
    h.load();
    h.add('only');
    expect(h.at(-1)).toBeUndefined();
  });
});

describe('InputHistory — round-trip across restart', () => {
  test('add → new instance .load → same snapshot', () => {
    const path = join(dir, 'h');
    const h1 = new InputHistory({ path });
    h1.load();
    h1.add('first');
    h1.add('second');
    const h2 = new InputHistory({ path });
    h2.load();
    expect(h2.snapshot()).toEqual(['first', 'second']);
  });
});
