// Bounded memory file tests: missing files read empty, replacements persist,
// and over-cap writes fail without truncating.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MEMORY_CAPS,
  normalizeMemoryFile,
  projectMemoryPath,
  readMemoryFile,
  readProjectMemoryFile,
  replaceMemoryFile,
  replaceProjectMemoryFile,
} from '@yevgetman/sov-sdk/memory/bounded';

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

  // D13 (audit F10/F16 sibling): memory holds arbitrary agent-recorded facts and
  // must not be world-readable on a shared host — file 0600, dir 0700, matching
  // the other HARNESS_HOME state sinks. chmod is a near no-op on Windows, so the
  // mode assertion is Unix-only.
  test.skipIf(process.platform === 'win32')(
    'writes memory files 0600 and their dir 0700',
    async () => {
      await withTmp(async (dir) => {
        const result = replaceMemoryFile('USER.md', 'sensitive dossier', dir);
        expect(result.ok).toBe(true);
        const filePath = join(dir, 'memory', 'USER.md');
        // RED before fix: default umask leaves the file 0644 and the dir 0755.
        expect(statSync(filePath).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'memory')).mode & 0o777).toBe(0o700);
      });
    },
  );
});

describe('per-project memory paths', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-pmem-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('projectMemoryPath returns <home>/memory/projects/<id>/MEMORY.md', () => {
    expect(projectMemoryPath(home, 'abc123')).toBe(
      join(home, 'memory', 'projects', 'abc123', 'MEMORY.md'),
    );
    // A legitimate dotted slug is still a valid single segment.
    expect(projectMemoryPath(home, 'acme.web')).toBe(
      join(home, 'memory', 'projects', 'acme.web', 'MEMORY.md'),
    );
  });

  // Polish-pass 2026-07-02 (MEDIUM) — projectId becomes a path segment and its
  // preferred source (bundle manifest) is operator-supplied and only string-
  // checked. A traversal id must be rejected before it can escape the memory
  // root, on BOTH the read and write paths (both go through projectMemoryPath).
  test('projectMemoryPath rejects a path-traversal projectId', () => {
    for (const bad of ['../../../../tmp/pwned', '..', '.', 'a/b', 'a\\b', 'x\0y', '']) {
      expect(() => projectMemoryPath(home, bad)).toThrow(/invalid project id/);
      expect(() => readProjectMemoryFile(bad, home)).toThrow(/invalid project id/);
      expect(() => replaceProjectMemoryFile(bad, '# x\n', home)).toThrow(/invalid project id/);
    }
  });

  test('readProjectMemoryFile returns empty content when file does not exist', () => {
    const result = readProjectMemoryFile('abc123', home);
    expect(result.content).toBe('');
    expect(result.current_chars).toBe(0);
    expect(result.cap).toBe(2200);
    expect(result.file).toBe('MEMORY.md');
    expect(result.path).toBe(projectMemoryPath(home, 'abc123'));
  });

  test('replaceProjectMemoryFile creates the projects/<id>/ dir and writes content', () => {
    const result = replaceProjectMemoryFile('abc123', '# hello\n', home);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('# hello\n');
      expect(result.current_chars).toBe(8);
    }
    const reread = readProjectMemoryFile('abc123', home);
    expect(reread.content).toBe('# hello\n');
  });

  test('replaceProjectMemoryFile rejects content exceeding the cap (2200)', () => {
    const big = 'x'.repeat(2201);
    const result = replaceProjectMemoryFile('abc123', big, home);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/capacity/i);
      expect(result.cap).toBe(2200);
    }
  });

  test('different projectIds get isolated files', () => {
    replaceProjectMemoryFile('proj-a', 'A content', home);
    replaceProjectMemoryFile('proj-b', 'B content', home);
    expect(readProjectMemoryFile('proj-a', home).content).toBe('A content');
    expect(readProjectMemoryFile('proj-b', home).content).toBe('B content');
  });

  test('per-project file does NOT collide with global MEMORY.md', () => {
    replaceMemoryFile('MEMORY.md', 'global content', home);
    replaceProjectMemoryFile('proj-a', 'project content', home);
    expect(readMemoryFile('MEMORY.md', home).content).toBe('global content');
    expect(readProjectMemoryFile('proj-a', home).content).toBe('project content');
  });

  test('per-project write does NOT touch USER.md (global)', () => {
    replaceMemoryFile('USER.md', 'user dossier', home);
    replaceProjectMemoryFile('proj-a', 'project notes', home);
    expect(readMemoryFile('USER.md', home).content).toBe('user dossier');
  });

  // D13: the same 0600/0700 tightening applies to per-project memory writers.
  test.skipIf(process.platform === 'win32')(
    'project memory files are 0600 and their dir 0700',
    () => {
      const result = replaceProjectMemoryFile('proj-perms', '# secret notes\n', home);
      expect(result.ok).toBe(true);
      const path = projectMemoryPath(home, 'proj-perms');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    },
  );
});
