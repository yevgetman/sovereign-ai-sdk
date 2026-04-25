// FileWriteTool tests — exercise create / overwrite / parent-dir-missing /
// directory-target failure paths in real tmp dirs.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../src/tool/types.js';
import { FileWriteTool } from '../../src/tools/FileWriteTool.js';

function makeCtx(cwd: string): ToolContext {
  return { cwd, bundleRoot: cwd, sessionId: 'test' };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-filewrite-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('FileWriteTool', () => {
  test('creates a new file and reports created=true', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'new.txt');
      const result = await FileWriteTool.call({ path: p, content: 'hello' }, makeCtx(dir));
      expect(result.data.created).toBe(true);
      expect(result.data.bytesWritten).toBe(5);
      expect(readFileSync(p, 'utf8')).toBe('hello');
      const rendered = FileWriteTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('created');
    });
  });

  test('overwrites an existing file and reports created=false', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'existing.txt');
      writeFileSync(p, 'old contents that are longer');
      const result = await FileWriteTool.call({ path: p, content: 'new' }, makeCtx(dir));
      expect(result.data.created).toBe(false);
      expect(readFileSync(p, 'utf8')).toBe('new');
      const rendered = FileWriteTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('wrote 3 bytes');
    });
  });

  test('throws when the parent directory does not exist', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'no', 'such', 'parent', 'f.txt');
      await expect(FileWriteTool.call({ path: p, content: 'x' }, makeCtx(dir))).rejects.toThrow(
        /parent directory does not exist/,
      );
      expect(existsSync(p)).toBe(false);
    });
  });

  test('throws when the target path is a directory', async () => {
    await withTmp(async (dir) => {
      const p = join(dir, 'subdir');
      mkdirSync(p);
      await expect(FileWriteTool.call({ path: p, content: 'x' }, makeCtx(dir))).rejects.toThrow(
        /directory, not a file/,
      );
    });
  });

  test('writes are not isReadOnly and isConcurrencySafe (path overlap handled by orchestrator)', () => {
    expect(FileWriteTool.isReadOnly({ path: '/tmp/x', content: 'y' })).toBe(false);
    expect(FileWriteTool.isConcurrencySafe({ path: '/tmp/x', content: 'y' })).toBe(true);
    expect(FileWriteTool.affectedPaths?.({ path: '/tmp/x', content: 'y' })).toEqual(['/tmp/x']);
  });

  test('checkPermissions returns ask', async () => {
    const result = await FileWriteTool.checkPermissions(
      { path: '/tmp/x', content: 'y' },
      makeCtx('/tmp'),
    );
    expect(result.behavior).toBe('ask');
  });

  test('preparePermissionMatcher supports aliases and path globs', async () => {
    expect(FileWriteTool.aliases).toContain('Write');
    const matcher = await FileWriteTool.preparePermissionMatcher?.({
      path: 'notes/output.md',
      content: 'x',
    });
    expect(matcher?.('*.md')).toBe(true);
    expect(matcher?.('output.md')).toBe(true);
    expect(matcher?.('*.ts')).toBe(false);
  });
});
