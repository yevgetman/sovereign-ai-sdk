// GlobTool tests — uses Bun.Glob; pure JS, no shell-out.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ToolContext } from '../../src/tool/types.js';
import { GlobTool } from '../../src/tools/GlobTool.js';
import { summarizeToolResult } from '../../src/ui/toolFooter.js';

function makeCtx(cwd: string): ToolContext {
  return { cwd, bundleRoot: cwd, sessionId: 'test' };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-glob-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withHomeTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(homedir(), '.sovereign-glob-home-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asHomePath(path: string): string {
  return `~/${relative(homedir(), path)}`;
}

describe('GlobTool', () => {
  test('matches simple top-level pattern', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.ts'), '');
      writeFileSync(join(dir, 'b.ts'), '');
      writeFileSync(join(dir, 'c.md'), '');
      const result = await GlobTool.call({ pattern: '*.ts' }, makeCtx(dir));
      expect(result.data.paths.sort()).toEqual(['a.ts', 'b.ts']);
    });
  });

  test('matches recursive ** patterns', async () => {
    await withTmp(async (dir) => {
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), '');
      writeFileSync(join(dir, 'src', 'nested', 'b.ts'), '');
      writeFileSync(join(dir, 'top.md'), '');
      const result = await GlobTool.call({ pattern: '**/*.ts' }, makeCtx(dir));
      expect(result.data.paths).toContain('src/a.ts');
      expect(result.data.paths).toContain('src/nested/b.ts');
      expect(result.data.paths.some((p) => p.endsWith('top.md'))).toBe(false);
    });
  });

  test('honors path option for relative root', async () => {
    await withTmp(async (dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'x.txt'), '');
      writeFileSync(join(dir, 'sub', 'y.txt'), '');
      writeFileSync(join(dir, 'z.txt'), ''); // outside
      const result = await GlobTool.call({ pattern: '*.txt', path: 'sub' }, makeCtx(dir));
      expect(result.data.paths.sort()).toEqual(['x.txt', 'y.txt']);
    });
  });

  test('expands leading ~/ path roots before scanning', async () => {
    await withHomeTmp(async (dir) => {
      writeFileSync(join(dir, 'home.txt'), '');
      const result = await GlobTool.call(
        { pattern: '*.txt', path: asHomePath(dir) },
        makeCtx('/tmp'),
      );
      expect(result.data.paths).toEqual(['home.txt']);
    });
  });

  test('returns empty array when nothing matches', async () => {
    await withTmp(async (dir) => {
      const result = await GlobTool.call({ pattern: '*.nope' }, makeCtx(dir));
      expect(result.data.paths).toEqual([]);
      expect(result.data.truncated).toBe(false);
      const rendered = GlobTool.renderResult?.(result.data);
      expect(rendered?.content).toBe('(no matches)');
    });
  });

  test('head_limit caps results and marks truncated', async () => {
    await withTmp(async (dir) => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(dir, `f${i}.txt`), '');
      }
      const result = await GlobTool.call({ pattern: '*.txt', head_limit: 3 }, makeCtx(dir));
      expect(result.data.paths.length).toBe(3);
      expect(result.data.truncated).toBe(true);
    });
  });

  test('returns lexicographically sorted paths for determinism', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'c.txt'), '');
      writeFileSync(join(dir, 'a.txt'), '');
      writeFileSync(join(dir, 'b.txt'), '');
      const result = await GlobTool.call({ pattern: '*.txt' }, makeCtx(dir));
      expect(result.data.paths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    });
  });

  test('isReadOnly + isConcurrencySafe = true; no affectedPaths (not path-scoped)', () => {
    expect(GlobTool.isReadOnly({ pattern: '*' })).toBe(true);
    expect(GlobTool.isConcurrencySafe({ pattern: '*' })).toBe(true);
    expect(GlobTool.affectedPaths).toBeUndefined();
  });

  // Pins the consistency invariant for backlog item 18: whatever count
  // GlobTool's envelope reports in `summary:`, the inline UI footer must
  // report the SAME count. The renderer used to read totalLines (which
  // includes the envelope header rows + a blank separator), so a 1-file
  // result yielded "found 4 files" while the envelope said "1 file".
  for (const fileCount of [1, 4, 50]) {
    test(`envelope summary count == footer count for ${fileCount}-file result`, async () => {
      await withTmp(async (dir) => {
        for (let i = 0; i < fileCount; i++) {
          writeFileSync(join(dir, `f${i.toString().padStart(2, '0')}.ts`), '');
        }
        const result = await GlobTool.call({ pattern: '*.ts' }, makeCtx(dir));
        expect(result.observation?.summary).toBe(`${fileCount} file${fileCount === 1 ? '' : 's'}`);

        // Reconstruct the inline-block content shape the renderer sees:
        // envelope header (status + summary + optional next_actions) +
        // blank separator + tool's own renderResult content.
        const envelopeHeader = [
          `status: ${result.observation?.status}`,
          `summary: ${result.observation?.summary}`,
        ].join('\n');
        const body = GlobTool.renderResult?.(result.data)?.content ?? '';
        const content = `${envelopeHeader}\n\n${body}`;
        const totalLines = content.split('\n').length;

        const footer = summarizeToolResult({
          toolName: 'Glob',
          content,
          isError: false,
          totalLines,
        });
        expect(footer.primary).toBe(`found ${fileCount} file${fileCount === 1 ? '' : 's'}`);
      });
    });
  }
});
