// @-reference expansion tests for files, folders, sensitive paths, diffs,
// and URLs with an injected fetch implementation.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandContextReferences } from '../../src/context/references.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-references-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('expandContextReferences', () => {
  test('injects file contents with line ranges', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'sample.ts'), 'one\ntwo\nthree\n');
      const out = await expandContextReferences('Read @file:sample.ts:2-3 now', { cwd: dir });
      expect(out).toContain('<referenced-file');
      expect(out).toContain('```ts');
      expect(out).toContain('two\nthree');
      expect(out).not.toContain('one\n');
    });
  });

  test('supports quoted file paths with spaces', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'has space.md'), '# Title');
      const out = await expandContextReferences('Read @file:"has space.md"', { cwd: dir });
      expect(out).toContain('# Title');
      expect(out).toContain('```md');
    });
  });

  test('injects folder structure only', async () => {
    await withTmp(async (dir) => {
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'secret content');
      writeFileSync(join(dir, 'src', 'nested', 'b.ts'), 'more secret content');
      const out = await expandContextReferences('@folder:src', { cwd: dir });
      expect(out).toContain('a.ts');
      expect(out).toContain('nested/');
      expect(out).not.toContain('secret content');
    });
  });

  test('blocks sensitive paths', async () => {
    await withTmp(async (dir) => {
      const home = join(dir, 'home');
      mkdirSync(join(home, '.ssh'), { recursive: true });
      writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
      const out = await expandContextReferences('@file:~/.ssh/id_rsa', { cwd: dir, homeDir: home });
      expect(out).toContain('[BLOCKED: sensitive path');
      expect(out).not.toContain('PRIVATE KEY');
    });
  });

  test('injects URL text through fetchImpl', async () => {
    const out = await expandContextReferences('@url:https://example.test/x', {
      fetchImpl: (async () =>
        new Response('hello from url', { status: 200 })) as unknown as typeof fetch,
    });
    expect(out).toContain('<referenced-url');
    expect(out).toContain('hello from url');
  });
});
