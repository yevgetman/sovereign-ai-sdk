// Phase 13.3 follow-up (Backlog Item 2) — round-trip audit for the C2
// auto-promote provenance comment. Verifies MEMORY.md written via the
// auto-promote bypass path is loader-readable AND the provenance comment
// is preserved through filesystem read.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemoryFile } from '@yevgetman/sov-sdk/memory/bounded';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { MemoryProposeTool } from '../../src/tools/MemoryProposeTool.js';

function makeCtx(home: string, sessionId = 'sess-audit-1'): ToolContext {
  return {
    cwd: '/tmp',
    sessionId,
    harnessHome: home,
    reviewAutoPromoteMemory: true,
  } as ToolContext;
}

describe('MemoryProposeTool auto-promote — provenance audit', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-mempropose-audit-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('auto-promote MEMORY.md round-trips through readMemoryFile cleanly', async () => {
    await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'Use pnpm not npm in this repo',
        sourceMessageRange: [0, 5],
        sourceExcerpt: 'simple excerpt',
        traceId: 'trace-audit-1',
      },
      makeCtx(home),
    );

    // Loader perspective: read via the same path the runtime uses
    const result = readMemoryFile('MEMORY.md', home);
    expect(result.content).toContain('Use pnpm not npm in this repo');
    // Provenance comment preserved
    expect(result.content).toContain('proposal:');
    expect(result.content).toContain('auto-promoted');
    expect(result.content).toContain('session:sess-audit-1');
    expect(result.content).toContain('trace:trace-audit-1');
    expect(result.content).toContain('range:0-5');
    expect(result.content).toContain('hash:sha256:');
    expect(result.content).toContain('excerpt:simple excerpt');
    // Loader sees the right file metadata
    expect(result.file).toBe('MEMORY.md');
    expect(result.current_chars).toBe(result.content.length);
  });

  test('auto-promote with double-dash in excerpt: -- escaped to single dash; loader-safe', async () => {
    await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'pattern with embedded --double-dash in excerpt',
        sourceMessageRange: [0, 1],
        sourceExcerpt: 'this -- contains -- a few -- doubles',
        traceId: 'trace-audit-2',
      },
      makeCtx(home),
    );

    const memContent = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    // The provenance comment's *content* (between <!-- and -->) must not
    // contain '--' (which would terminate the HTML comment early). The
    // outer `<!--` / `-->` delimiters legitimately contain dashes.
    const commentLine = memContent.split('\n').find((l) => l.includes('proposal:')) ?? '';
    const commentInner = commentLine.replace(/^.*<!--\s*/, '').replace(/\s*-->.*$/, '');
    expect(commentInner).not.toContain('--');
    expect(commentInner).toContain('this - contains - a few - doubles');
    // Loader still works
    const loaded = readMemoryFile('MEMORY.md', home);
    expect(loaded.content).toContain('pattern with embedded --double-dash in excerpt');
  });

  test('auto-promote with empty excerpt: still writes valid file + readable', async () => {
    await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'note',
        sourceMessageRange: [0, 0],
        sourceExcerpt: '',
        traceId: 'trace-audit-3',
      },
      makeCtx(home),
    );

    const memContent = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    expect(memContent).toContain('note');
    expect(memContent).toContain('excerpt:'); // present even when empty
    // Loader doesn't choke
    const loaded = readMemoryFile('MEMORY.md', home);
    expect(loaded.content).toContain('note');
    expect(loaded.content).toContain('proposal:');
  });

  test('auto-promote with very long excerpt (>200 chars): truncated cleanly', async () => {
    const longExcerpt = 'a'.repeat(500);
    await MemoryProposeTool.call(
      {
        target: 'MEMORY.md',
        memoryType: 'project',
        body: 'long excerpt note',
        sourceMessageRange: [0, 1],
        sourceExcerpt: longExcerpt,
        traceId: 'trace-audit-4',
      },
      makeCtx(home),
    );

    const memContent = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf-8');
    const commentLine = memContent.split('\n').find((l) => l.includes('proposal:')) ?? '';
    // Truncated at 200 chars + '...' sentinel from escapeForHtmlComment
    expect(commentLine.length).toBeLessThan(800);
    expect(commentLine).toContain('aaaa');
    expect(commentLine).toContain('...');
    // Loader still works
    const loaded = readMemoryFile('MEMORY.md', home);
    expect(loaded.content).toContain('long excerpt note');
  });
});
