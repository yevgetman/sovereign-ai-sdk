// Bounded memory file tests: missing files read empty, replacements persist,
// and over-cap writes fail without truncating.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_CAPS,
  normalizeMemoryFile,
  readMemoryFile,
  replaceMemoryFile,
} from '../../src/memory/bounded.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-memory-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bounded memory files', () => {
  test('normalizes file aliases', () => {
    expect(normalizeMemoryFile('memory')).toBe('MEMORY.md');
    expect(normalizeMemoryFile('USER.md')).toBe('USER.md');
    expect(() => normalizeMemoryFile('nope')).toThrow(/unknown memory file/);
  });

  test('missing file reads as empty', async () => {
    await withTmp(async (dir) => {
      const result = readMemoryFile('USER.md', dir);
      expect(result.content).toBe('');
      expect(result.current_chars).toBe(0);
      expect(result.cap).toBe(MEMORY_CAPS['USER.md']);
    });
  });

  test('replace persists when content is within cap', async () => {
    await withTmp(async (dir) => {
      const result = replaceMemoryFile('USER.md', 'prefers terse answers', dir);
      expect(result.ok).toBe(true);
      expect(readFileSync(join(dir, 'memory', 'USER.md'), 'utf8')).toBe('prefers terse answers');
    });
  });

  test('replace over cap returns an error and does not write', async () => {
    await withTmp(async (dir) => {
      const result = replaceMemoryFile('USER.md', 'x'.repeat(MEMORY_CAPS['USER.md'] + 1), dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('at capacity');
        expect(result.current_chars).toBe(MEMORY_CAPS['USER.md'] + 1);
      }
      expect(readMemoryFile('USER.md', dir).content).toBe('');
    });
  });
});
