// FileReadTool tests — touch the real filesystem in a per-test tmp dir
// so the tool's path resolution and stat behavior is exercised end-to-end.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ToolContext } from '../../src/tool/types.js';
import { FileReadTool } from '../../src/tools/FileReadTool.js';

function makeCtx(cwd: string): ToolContext {
  return { cwd, bundleRoot: cwd, sessionId: 'test' };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-fileread-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withHomeTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(homedir(), '.sovereign-fileread-home-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asHomePath(path: string): string {
  return `~/${relative(homedir(), path)}`;
}

describe('FileReadTool', () => {
  test('reads a small file and returns numbered output via renderResult', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'sample.txt');
      writeFileSync(p, 'one\ntwo\nthree\n');
      const result = await FileReadTool.call({ path: p }, makeCtx(dir));
      expect(result.data.lines).toEqual(['one', 'two', 'three']);
      expect(result.data.totalLines).toBe(3);
      expect(result.data.startLine).toBe(1);
      const rendered = FileReadTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('1\tone');
      expect(rendered?.content).toContain('3\tthree');
      expect(rendered?.isError).toBeFalsy();
    });
  });

  test('honors offset and limit', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'sample.txt');
      writeFileSync(p, 'a\nb\nc\nd\ne\n');
      const result = await FileReadTool.call({ path: p, offset: 1, limit: 2 }, makeCtx(dir));
      expect(result.data.lines).toEqual(['b', 'c']);
      expect(result.data.startLine).toBe(2);
      expect(result.data.totalLines).toBe(5);
    });
  });

  test('resolves relative paths against ctx.cwd', async () => {
    await withTmp(async (dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'r.txt'), 'rel');
      const result = await FileReadTool.call({ path: 'sub/r.txt' }, makeCtx(dir));
      expect(result.data.lines).toEqual(['rel']);
      expect(result.data.path).toBe(join(dir, 'sub', 'r.txt'));
    });
  });

  test('expands leading ~/ paths before reading', async () => {
    await withHomeTmp(async (dir) => {
      const p = join(dir, 'home-read.txt');
      writeFileSync(p, 'home');
      const result = await FileReadTool.call({ path: asHomePath(p) }, makeCtx('/tmp'));
      expect(result.data.path).toBe(p);
      expect(result.data.lines).toEqual(['home']);
    });
  });

  test('throws when the file does not exist', async () => {
    await withTmp(async (dir) => {
      await expect(
        FileReadTool.call({ path: join(dir, 'missing.txt') }, makeCtx(dir)),
      ).rejects.toThrow(/does not exist/);
    });
  });

  test('throws when path points to a directory', async () => {
    await withTmp(async (dir) => {
      await expect(FileReadTool.call({ path: dir }, makeCtx(dir))).rejects.toThrow(
        /directory, not a file/,
      );
    });
  });

  test('renders empty file message', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'empty.txt');
      writeFileSync(p, '');
      const result = await FileReadTool.call({ path: p }, makeCtx(dir));
      expect(result.data.totalLines).toBe(0);
      const rendered = FileReadTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('empty file');
    });
  });

  test('exposes isReadOnly + isConcurrencySafe = true and affectedPaths returns the input path', () => {
    expect(FileReadTool.isReadOnly({ path: '/tmp/x' })).toBe(true);
    expect(FileReadTool.isConcurrencySafe({ path: '/tmp/x' })).toBe(true);
    expect(FileReadTool.affectedPaths?.({ path: '/tmp/x' })).toEqual(['/tmp/x']);
  });

  test('checkPermissions allows without prompting', async () => {
    const result = await FileReadTool.checkPermissions({ path: '/tmp/x' }, makeCtx('/tmp'));
    expect(result.behavior).toBe('allow');
  });

  test('preparePermissionMatcher supports aliases and nested path globs', async () => {
    expect(FileReadTool.aliases).toContain('Read');
    const matcher = await FileReadTool.preparePermissionMatcher?.({ path: 'src/index.ts' });
    expect(matcher?.('*.ts')).toBe(true);
    expect(matcher?.('index.ts')).toBe(true);
    expect(matcher?.('*.md')).toBe(false);
  });
});
