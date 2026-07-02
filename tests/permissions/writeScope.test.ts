// Write-scope enforcement guard (2026-06-15 multi-agent workflows).

import { describe, expect, test } from 'bun:test';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import { wrapCanUseToolWithWriteScope } from '@yevgetman/sov-sdk/permissions/writeScope';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';

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

  // 2026-06-15 review fix M2 — harness-state writers (memory, skill_manage)
  // operate under $HARNESS_HOME, not the project tree; their bare-marker
  // affectedPaths must NOT be tested against the project-scope globs.
  test('harness-state tools (memory/skill_manage) defer to base, never scope-denied', async () => {
    const memory = {
      name: 'memory',
      affectedPaths: () => ['memory'],
    } as unknown as Tool<unknown, unknown>;
    const skill = {
      name: 'skill_manage',
      affectedPaths: () => ['skills/agent-created/foo/SKILL.md'],
    } as unknown as Tool<unknown, unknown>;
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/migrations/**']);
    expect((await guard(memory, { op: 'set' }, ctx)).behavior).toBe('allow');
    expect((await guard(skill, { name: 'foo' }, ctx)).behavior).toBe('allow');
  });

  // 2026-06-15 review fix M2 — a read-only tool that reports affectedPaths
  // (e.g. skills_view) must not be scope-checked (it never writes the tree).
  test('read-only tools defer to base regardless of affectedPaths', async () => {
    const view = {
      name: 'skills_view',
      isReadOnly: () => true,
      affectedPaths: (input: { path?: string }) => (input.path ? [input.path] : []),
    } as unknown as Tool<unknown, unknown>;
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/**']);
    expect((await guard(view, { path: 'anywhere/SKILL.md' }, ctx)).behavior).toBe('allow');
    expect((await guard(view, {}, ctx)).behavior).toBe('allow');
  });

  // 2026-06-15 review fix M1 — a write-capable tool that reports an EMPTY
  // affected-paths array fails CLOSED rather than falling through to allow.
  test('a write-capable tool reporting no affected path is denied (fail closed)', async () => {
    const emptyWriter = {
      name: 'BulkRename',
      affectedPaths: () => [],
    } as unknown as Tool<unknown, unknown>;
    const guard = wrapCanUseToolWithWriteScope(allow, ['src/**']);
    const res = await guard(emptyWriter, {}, ctx);
    expect(res.behavior).toBe('deny');
    expect(res.reason).toContain('no affected path');
  });

  // 2026-06-15 review fix M11 — a bare directory glob (no wildcard) admits its
  // whole subtree, matching the path-lock's containing-directory collapse.
  test('a bare directory glob admits writes under that directory', async () => {
    const guard = wrapCanUseToolWithWriteScope(allow, ['migrations']);
    expect((await guard(fileTool(), { path: '/work/migrations/001.sql' }, ctx)).behavior).toBe(
      'allow',
    );
    expect((await guard(fileTool(), { path: '/work/other/x.sql' }, ctx)).behavior).toBe('deny');
  });
});
