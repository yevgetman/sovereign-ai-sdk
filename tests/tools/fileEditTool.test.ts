// FileEditTool tests — unique-match (default) and replace_all modes,
// failure paths for zero / multi-match without replace_all, special-
// character safety in `new_string` (no regex/$&-style interpolation).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ToolContext } from '../../src/tool/types.js';
import { FileEditTool } from '../../src/tools/FileEditTool.js';

function makeCtx(cwd: string): ToolContext {
  return { cwd, bundleRoot: cwd, sessionId: 'test' };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-fileedit-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withHomeTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(homedir(), '.sovereign-fileedit-home-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asHomePath(path: string): string {
  return `~/${relative(homedir(), path)}`;
}

describe('FileEditTool', () => {
  test('unique-match replace happy path', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'alpha beta gamma');
      const result = await FileEditTool.call(
        { path: p, old_string: 'beta', new_string: 'BETA' },
        makeCtx(dir),
      );
      expect(result.data.replacements).toBe(1);
      expect(readFileSync(p, 'utf8')).toBe('alpha BETA gamma');
    });
  });

  test('multiple matches without replace_all is a clean failure that does not mutate the file', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      const original = 'foo foo foo';
      writeFileSync(p, original);
      await expect(
        FileEditTool.call({ path: p, old_string: 'foo', new_string: 'bar' }, makeCtx(dir)),
      ).rejects.toThrow(/3 matches/);
      expect(readFileSync(p, 'utf8')).toBe(original);
    });
  });

  test('replace_all: true replaces every occurrence', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'foo foo foo');
      const result = await FileEditTool.call(
        { path: p, old_string: 'foo', new_string: 'bar', replace_all: true },
        makeCtx(dir),
      );
      expect(result.data.replacements).toBe(3);
      expect(readFileSync(p, 'utf8')).toBe('bar bar bar');
    });
  });

  test('expands leading ~/ paths before editing', async () => {
    await withHomeTmp(async (dir) => {
      const p = join(dir, 'home-edit.txt');
      writeFileSync(p, 'before');
      const result = await FileEditTool.call(
        { path: asHomePath(p), old_string: 'before', new_string: 'after' },
        makeCtx('/tmp'),
      );
      expect(result.data.path).toBe(p);
      expect(readFileSync(p, 'utf8')).toBe('after');
    });
  });

  test('zero matches throws and does not mutate the file', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'hello world');
      await expect(
        FileEditTool.call({ path: p, old_string: 'absent', new_string: 'X' }, makeCtx(dir)),
      ).rejects.toThrow(/not found/);
      expect(readFileSync(p, 'utf8')).toBe('hello world');
    });
  });

  test('does not interpret $& and friends in new_string (literal substitution)', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'token here');
      const result = await FileEditTool.call(
        { path: p, old_string: 'token', new_string: '$&-LITERAL' },
        makeCtx(dir),
      );
      expect(result.data.replacements).toBe(1);
      expect(readFileSync(p, 'utf8')).toBe('$&-LITERAL here');
    });
  });

  test('throws when old_string === new_string', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'whatever');
      await expect(
        FileEditTool.call({ path: p, old_string: 'same', new_string: 'same' }, makeCtx(dir)),
      ).rejects.toThrow(/identical/);
    });
  });

  test('renders a user-readable summary', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'src.txt');
      writeFileSync(p, 'a b c');
      const result = await FileEditTool.call(
        { path: p, old_string: 'b', new_string: 'B' },
        makeCtx(dir),
      );
      const rendered = FileEditTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('1 replacement');
    });
  });

  test('exposes affectedPaths and is not isReadOnly', () => {
    const input = { path: '/tmp/x', old_string: 'a', new_string: 'b' };
    expect(FileEditTool.isReadOnly(input)).toBe(false);
    expect(FileEditTool.isConcurrencySafe(input)).toBe(true);
    expect(FileEditTool.affectedPaths?.(input)).toEqual(['/tmp/x']);
  });

  test('preparePermissionMatcher supports aliases and path globs', async () => {
    expect(FileEditTool.aliases).toContain('Edit');
    const matcher = await FileEditTool.preparePermissionMatcher?.({
      path: 'src/app.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(matcher?.('*.ts')).toBe(true);
    expect(matcher?.('app.ts')).toBe(true);
    expect(matcher?.('*.md')).toBe(false);
  });
});
