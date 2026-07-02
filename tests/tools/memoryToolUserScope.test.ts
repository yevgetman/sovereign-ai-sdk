// Phase E C1 (Critical) — MemoryTool must scope reads/writes by ctx.userId.
//
// The `memory` tool is reachable on the multi-user gateway and from sub-agents.
// Before the fix it called the bounded-memory path helpers WITHOUT the trailing
// `userId` arg, so every user's tool reads/writes hit the SHARED legacy
// `<harnessHome>/memory|…` files → cross-user data leak. These tests construct
// two ToolContexts that differ only in `userId` against ONE temp HARNESS_HOME
// and assert one user can never observe another user's content. A no-userId
// (undefined) context must still use the legacy top-level path (back-compat).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemoryFile } from '@yevgetman/sov-sdk/memory/bounded';
import type { ProjectScope } from '@yevgetman/sov-sdk/memory/scope';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { MemoryTool } from '@yevgetman/sov-sdk/tools/MemoryTool';

describe('MemoryTool — per-user isolation (Phase E C1)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-memtool-userscope-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function ctxFor(userId: string | undefined, projectScope?: ProjectScope): ToolContext {
    const base: ToolContext = {
      cwd: '/tmp',
      sessionId: `sess-${userId ?? 'legacy'}`,
      harnessHome: home,
    };
    if (userId !== undefined) base.userId = userId;
    if (projectScope) base.projectScope = projectScope;
    return base;
  }

  test('alice MEMORY.md write is NOT visible to bob (view-all)', async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'ALICE-SECRET' },
      ctxFor('alice'),
    );
    const bobView = await MemoryTool.call({ action: 'view' }, ctxFor('bob'));
    expect(JSON.stringify(bobView.data.result)).not.toContain('ALICE-SECRET');
  });

  test('alice MEMORY.md write is NOT visible to bob (view specific file)', async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'ALICE-SECRET' },
      ctxFor('alice'),
    );
    const bobView = await MemoryTool.call({ action: 'view', file: 'MEMORY.md' }, ctxFor('bob'));
    expect(JSON.stringify(bobView.data.result)).not.toContain('ALICE-SECRET');
  });

  test('alice USER.md write is NOT visible to bob', async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'USER.md', content: 'ALICE-USER-SECRET' },
      ctxFor('alice'),
    );
    const bobView = await MemoryTool.call({ action: 'view', file: 'USER.md' }, ctxFor('bob'));
    expect(JSON.stringify(bobView.data.result)).not.toContain('ALICE-USER-SECRET');
  });

  test("alice's own write IS visible to alice (sanity: scoping isn't just dropping data)", async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'ALICE-SECRET' },
      ctxFor('alice'),
    );
    const aliceView = await MemoryTool.call({ action: 'view', file: 'MEMORY.md' }, ctxFor('alice'));
    expect(JSON.stringify(aliceView.data.result)).toContain('ALICE-SECRET');
  });

  test('alice + bob project-scoped MEMORY.md do not cross over', async () => {
    const proj: ProjectScope = { kind: 'project', id: 'proj1', name: 'p' };
    await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'ALICE-PROJECT-SECRET' },
      ctxFor('alice', proj),
    );
    const bobView = await MemoryTool.call(
      { action: 'view', file: 'MEMORY.md' },
      ctxFor('bob', proj),
    );
    expect(JSON.stringify(bobView.data.result)).not.toContain('ALICE-PROJECT-SECRET');
  });

  test('no-userId (undefined) context uses the legacy top-level path (back-compat)', async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'LEGACY-CONTENT' },
      ctxFor(undefined),
    );
    // The legacy bounded-memory read (userId omitted) must see exactly what the
    // tool wrote — i.e. the tool wrote to the legacy file, not a user namespace.
    expect(readMemoryFile('MEMORY.md', home).content).toBe('LEGACY-CONTENT');
    // And a per-user view must NOT see the legacy content.
    const aliceView = await MemoryTool.call({ action: 'view', file: 'MEMORY.md' }, ctxFor('alice'));
    expect(JSON.stringify(aliceView.data.result)).not.toContain('LEGACY-CONTENT');
  });

  test("a user's USER.md write lands under users/{userId}/ not the legacy file", async () => {
    await MemoryTool.call(
      { action: 'replace', file: 'USER.md', content: 'ALICE-USER-SECRET' },
      ctxFor('alice'),
    );
    // Legacy file must remain empty — proves the write was user-scoped.
    expect(readMemoryFile('USER.md', home).content).toBe('');
    // Per-user read sees it.
    expect(readMemoryFile('USER.md', home, 'alice').content).toBe('ALICE-USER-SECRET');
  });
});
