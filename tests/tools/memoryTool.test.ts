// MemoryTool tests. Exercises view, replace, cap error, and memory-write hook.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_CAPS, readMemoryFile } from '../../src/memory/bounded.js';
import type { ToolContext } from '../../src/tool/types.js';
import { MemoryTool } from '../../src/tools/MemoryTool.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-memory-tool-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ctx(dir: string, onWrite?: () => void): ToolContext {
  const base: ToolContext = {
    cwd: dir,
    bundleRoot: dir,
    sessionId: 'test',
    harnessHome: dir,
  };
  if (onWrite) {
    base.memoryManager = {
      async prefetchSnapshot() {
        return '';
      },
      async syncTurn() {},
      async onMemoryWrite() {
        onWrite();
      },
      async onDelegation() {},
    };
  }
  return base;
}

describe('MemoryTool', () => {
  test('replace writes USER.md and fires memory write hook', async () => {
    await withTmp(async (dir) => {
      let writes = 0;
      const result = await MemoryTool.call(
        { action: 'replace', file: 'user.md', content: 'prefers terse answers' },
        ctx(dir, () => writes++),
      );
      expect(result.data.ok).toBe(true);
      expect(readMemoryFile('USER.md', dir).content).toBe('prefers terse answers');
      expect(writes).toBe(1);
    });
  });

  test('view reads both files when file is omitted', async () => {
    await withTmp(async (dir) => {
      await MemoryTool.call({ action: 'replace', file: 'MEMORY.md', content: 'note' }, ctx(dir));
      const result = await MemoryTool.call({ action: 'view' }, ctx(dir));
      expect(result.data.ok).toBe(true);
      expect(JSON.stringify(result.data.result)).toContain('MEMORY.md');
      expect(JSON.stringify(result.data.result)).toContain('note');
    });
  });

  test('over-cap replace returns is_error render output', async () => {
    await withTmp(async (dir) => {
      const result = await MemoryTool.call(
        { action: 'replace', file: 'USER.md', content: 'x'.repeat(MEMORY_CAPS['USER.md'] + 1) },
        ctx(dir),
      );
      expect(result.data.ok).toBe(false);
      const rendered = MemoryTool.renderResult?.(result.data);
      expect(rendered?.isError).toBe(true);
      expect(rendered?.content).toContain('at capacity');
    });
  });
});
