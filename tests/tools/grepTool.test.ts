// GrepTool tests — shell out to ripgrep against a tmp dir fixture.
// Skipped automatically when `rg` is not on PATH.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { GrepTool } from '@yevgetman/sov-sdk/tools/GrepTool';

const RG_AVAILABLE = await isRgAvailable();

async function isRgAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['rg', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  return { cwd, bundleRoot: cwd, sessionId: 'test', ...(signal ? { signal } : {}) };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-grep-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withHomeTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(homedir(), '.sovereign-grep-home-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asHomePath(path: string): string {
  return `~/${relative(homedir(), path)}`;
}

const dscribe = RG_AVAILABLE ? describe : describe.skip;

dscribe('GrepTool', () => {
  test('finds matching lines in content mode', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'apple\nbanana\ncherry\n');
      writeFileSync(join(dir, 'b.txt'), 'banana split\ncoffee\n');
      const result = await GrepTool.call({ pattern: 'banana' }, makeCtx(dir));
      expect(result.data.matches.length).toBeGreaterThan(0);
      const joined = result.data.matches.join('\n');
      expect(joined).toContain('banana');
    });
  });

  test('files_with_matches mode returns paths only', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'b.md'), '# heading\nexport elsewhere\n');
      const result = await GrepTool.call(
        { pattern: 'export', output_mode: 'files_with_matches' },
        makeCtx(dir),
      );
      expect(result.data.matches.length).toBe(2);
      const joined = result.data.matches.join('\n');
      expect(joined).toContain('a.ts');
      expect(joined).toContain('b.md');
    });
  });

  test('count mode returns per-file counts', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'foo\nfoo\nbar\n');
      writeFileSync(join(dir, 'b.txt'), 'foo\nfoo\nfoo\n');
      const result = await GrepTool.call({ pattern: 'foo', output_mode: 'count' }, makeCtx(dir));
      const joined = result.data.matches.join('\n');
      expect(joined).toContain('a.txt:2');
      expect(joined).toContain('b.txt:3');
    });
  });

  test('glob filter restricts to matching files', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'keep.ts'), 'needle\n');
      writeFileSync(join(dir, 'skip.md'), 'needle\n');
      const result = await GrepTool.call(
        { pattern: 'needle', output_mode: 'files_with_matches', glob: '*.ts' },
        makeCtx(dir),
      );
      const joined = result.data.matches.join('\n');
      expect(joined).toContain('keep.ts');
      expect(joined).not.toContain('skip.md');
    });
  });

  test('case_insensitive matches across case', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'Hello\nHELLO\nhello\n');
      const result = await GrepTool.call(
        { pattern: 'hello', case_insensitive: true, output_mode: 'count' },
        makeCtx(dir),
      );
      expect(result.data.matches[0]).toContain('3');
    });
  });

  test('no matches returns empty array, not an error', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'apple');
      const result = await GrepTool.call({ pattern: 'banana' }, makeCtx(dir));
      expect(result.data.matches).toEqual([]);
      expect(result.data.truncated).toBe(false);
      const rendered = GrepTool.renderResult?.(result.data);
      expect(rendered?.content).toBe('(no matches)');
    });
  });

  // F15 — a ripgrep killed by a signal (upstream turn-cancel, OOM/SIGKILL,
  // external kill) must NEVER be reported to the model as an authoritative
  // "no matches". With an already-aborted upstream signal the spawn shim
  // short-circuits (exited=143), and GrepTool must THROW an explicit
  // interrupted/incomplete error rather than returning {matches:[]}.
  test('a cancelled search throws (never reported as "no matches")', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'apple\nbanana\n');
      const ctl = new AbortController();
      ctl.abort(); // upstream turn-cancel already fired
      await expect(GrepTool.call({ pattern: 'banana' }, makeCtx(dir, ctl.signal))).rejects.toThrow(
        /interrupted|incomplete|killed/i,
      );
    });
  });

  // F15 regression — a GENUINE ripgrep error (exit 2, e.g. an invalid regex)
  // must still throw, not be swallowed as "no matches".
  test('a ripgrep error (invalid regex, exit 2) still throws', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'apple\n');
      // '[' is an unclosed character class → ripgrep exits 2 with a parse error.
      await expect(GrepTool.call({ pattern: '[' }, makeCtx(dir))).rejects.toThrow();
    });
  });

  test('head_limit caps results and marks truncated', async () => {
    await withTmp(async (dir) => {
      const lines = Array.from({ length: 50 }, (_, i) => `match ${i}`).join('\n');
      writeFileSync(join(dir, 'a.txt'), lines);
      const result = await GrepTool.call({ pattern: 'match', head_limit: 5 }, makeCtx(dir));
      expect(result.data.matches.length).toBe(5);
      expect(result.data.truncated).toBe(true);
      const rendered = GrepTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('[truncated]');
    });
  });

  // FIX 3 — output exceeding MAX_OUTPUT_BYTES (256 KiB) is truncated by the
  // stream reader. Before the fix the reader's local `truncated` flag was dead
  // (never returned), so byte-capped output was silently cut with
  // `truncated: false`. Generate >256 KiB of matching content and assert the
  // tool reports `truncated: true` (with no head_limit set, so the only source
  // of truncation is the byte cap), and that the kept text ends on a complete
  // line (no half-line at the cap boundary).
  test('byte-cap truncation reports truncated:true and keeps whole lines', async () => {
    await withTmp(async (dir) => {
      // Each line is ~100 bytes; 4000 lines ≈ 400 KiB > the 256 KiB cap.
      const line = `match ${'x'.repeat(90)}`;
      const lines = Array.from({ length: 4000 }, () => line).join('\n');
      writeFileSync(join(dir, 'big.txt'), `${lines}\n`);
      const result = await GrepTool.call({ pattern: 'match' }, makeCtx(dir));
      // No head_limit → the ONLY truncation source is the byte cap.
      expect(result.data.truncated).toBe(true);
      // Every returned match is a complete line (the cap trimmed to the last
      // newline, so no match is split mid-way).
      for (const m of result.data.matches) {
        expect(m).toContain('match ');
      }
      // The rendered result advertises truncation to the model.
      const rendered = GrepTool.renderResult?.(result.data);
      expect(rendered?.content).toContain('[truncated]');
    });
  });

  test('searches under an explicit subdirectory', async () => {
    await withTmp(async (dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'a.txt'), 'inside\n');
      writeFileSync(join(dir, 'a.txt'), 'outside\n');
      const result = await GrepTool.call({ pattern: 'inside', path: 'sub' }, makeCtx(dir));
      expect(result.data.matches.length).toBeGreaterThan(0);
      expect(result.data.matches.join('\n')).toContain('inside');
    });
  });

  test('expands leading ~/ paths before searching', async () => {
    await withHomeTmp(async (dir) => {
      writeFileSync(join(dir, 'home.txt'), 'home-needle\n');
      const result = await GrepTool.call(
        { pattern: 'home-needle', path: asHomePath(dir) },
        makeCtx('/tmp'),
      );
      expect(result.data.matches.join('\n')).toContain('home-needle');
    });
  });
});
