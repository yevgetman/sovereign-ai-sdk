// Write-scope enforcement guard (2026-06-15 multi-agent workflows).

import { describe, expect, test } from 'bun:test';
import type { CanUseTool } from '../../src/permissions/types.js';
import { wrapCanUseToolWithWriteScope } from '../../src/permissions/writeScope.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

const ctx = { cwd: '/work' } as unknown as ToolContext;

/** A file-writing tool: declares its target via affectedPaths (like FileWrite). */
const fileTool = (name = 'FileWrite'): Tool<unknown, unknown> =>
  ({ name, affectedPaths: (input: { path: string }) => [input.path] }) as unknown as Tool<
    unknown,
    unknown
  >;

const bashTool = { name: 'Bash' } as unknown as Tool<unknown, unknown>;
const readTool = { name: 'FileRead' } as unknown as Tool<unknown, unknown>; // no affectedPaths

const allow: CanUseTool = async () => ({ behavior: 'allow' });
const deny: CanUseTool = async () => ({ behavior: 'deny', reason: 'base says no' });

describe('wrapCanUseToolWithWriteScope', () => {
  test('allows an in-scope file write (defers to base)', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/foo/**']);
    const res = await guard(fileTool(), { path: '/work/src/foo/bar.ts' }, ctx);
    expect(res.behavior).toBe('allow');
  });

  test('denies an out-of-scope file write', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/foo/**']);
    const res = await guard(fileTool(), { path: '/work/src/other/x.ts' }, ctx);
    expect(res.behavior).toBe('deny');
    expect(res.reason).toContain('outside this task');
  });

  test('denies a write escaping cwd entirely', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['**']);
    const res = await guard(fileTool(), { path: '/etc/passwd' }, ctx);
    expect(res.behavior).toBe('deny');
  });

  test('an in-scope write still respects a base deny (scope is an ADDITIONAL gate)', async () => {
    const guard = wrapCanUseToolWithWriteScope(deny, ['src/**']);
    const res = await guard(fileTool(), { path: '/work/src/a.ts' }, ctx);
    expect(res.behavior).toBe('deny');
    expect(res.reason).toBe('base says no');
  });

  test('denies write-capable Bash in a narrowly-scoped task', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/foo/**']);
    const res = await guard(bashTool, { command: 'rm -rf src/foo' }, ctx);
    expect(res.behavior).toBe('deny');
    expect(res.reason).toContain('write-capable shell');
  });

  test('allows read-only Bash in a scoped task', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/foo/**']);
    const res = await guard(bashTool, { command: 'cat src/foo/a.ts' }, ctx);
    expect(res.behavior).toBe('allow');
  });

  test('passes non-writing tools through to base', async () => {
    const guard = wrapCanUseToolWithWriteScope(deny, ['src/**']);
    const res = await guard(readTool, { path: '/anywhere/x.ts' }, ctx);
    expect(res.behavior).toBe('deny'); // deferred to base (no affectedPaths, not Bash)
  });

  test("['**'] permits the whole tree", async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['**']);
    const res = await guard(fileTool(), { path: '/work/anywhere/deep/x.ts' }, ctx);
    expect(res.behavior).toBe('allow');
  });
});
