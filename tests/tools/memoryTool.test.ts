// MemoryTool tests. Exercises view, replace, cap error, memory-write hook,
// and (Item 19) per-scope routing between global and per-project MEMORY.md.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_CAPS,
  readMemoryFile,
  readProjectMemoryFile,
  replaceMemoryFile,
  replaceProjectMemoryFile,
} from '../../src/memory/bounded.js';
import type { ProjectScope } from '../../src/memory/scope.js';
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

describe('MemoryTool — scope routing (Item 19)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-mtsc-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeCtx(projectScope?: ProjectScope): ToolContext {
    const base: ToolContext = {
      cwd: '/tmp',
      sessionId: 'test',
      harnessHome: home,
    };
    if (projectScope) base.projectScope = projectScope;
    return base;
  }

  const projectFixture: ProjectScope = { kind: 'project', id: 'proj1', name: 'p' };

  test('replace MEMORY.md without scope arg + no projectScope → writes global', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'global only' },
      makeCtx(),
    );
    expect(result.observation?.status).toBe('success');
    expect(readMemoryFile('MEMORY.md', home).content).toBe('global only');
    expect(result.observation?.summary).toContain('scope=global');
  });

  test('replace MEMORY.md without scope arg + projectScope present → writes project', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'project content' },
      makeCtx(projectFixture),
    );
    expect(result.observation?.status).toBe('success');
    // global untouched
    expect(readMemoryFile('MEMORY.md', home).content).toBe('');
    // project file written
    expect(readProjectMemoryFile('proj1', home).content).toBe('project content');
    expect(result.observation?.summary).toContain('scope=project');
    expect(result.observation?.artifacts).toEqual(['memory/projects/proj1/MEMORY.md']);
  });

  test('replace MEMORY.md with scope: global + projectScope present → writes global', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'global content', scope: 'global' },
      makeCtx(projectFixture),
    );
    expect(result.observation?.status).toBe('success');
    expect(readMemoryFile('MEMORY.md', home).content).toBe('global content');
    expect(readProjectMemoryFile('proj1', home).content).toBe('');
    expect(result.observation?.artifacts).toEqual(['memory/MEMORY.md']);
  });

  test('replace MEMORY.md with scope: project + no projectScope → REJECTED', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'project content', scope: 'project' },
      makeCtx(),
    );
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('project scope requires');
    expect(result.observation?.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('omit')]),
    );
    expect(readMemoryFile('MEMORY.md', home).content).toBe('');
  });

  test('replace MEMORY.md with scope: project + projectScope.kind=none → REJECTED', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'x', scope: 'project' },
      makeCtx({ kind: 'none' }),
    );
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('project scope requires');
  });

  test('replace USER.md with scope: project + projectScope present → silently routes to global', async () => {
    const result = await MemoryTool.call(
      { action: 'replace', file: 'USER.md', content: 'user dossier', scope: 'project' },
      makeCtx(projectFixture),
    );
    expect(result.observation?.status).toBe('success');
    expect(result.observation?.summary).toContain('USER.md is always global');
    expect(readMemoryFile('USER.md', home).content).toBe('user dossier');
    expect(result.observation?.artifacts).toEqual(['memory/USER.md']);
  });

  test('view with no scope + projectScope present → returns both global and project files', async () => {
    replaceMemoryFile('MEMORY.md', 'GLOBAL', home);
    replaceProjectMemoryFile('proj1', 'PROJECT', home);
    const result = await MemoryTool.call({ action: 'view' }, makeCtx(projectFixture));
    expect(result.data.ok).toBe(true);
    const json = JSON.stringify(result.data.result);
    expect(json).toContain('GLOBAL');
    expect(json).toContain('PROJECT');
    expect(json).toContain('MEMORY.md@project');
  });

  test('view with no scope + no projectScope → returns global files only', async () => {
    replaceMemoryFile('MEMORY.md', 'GLOBAL', home);
    const result = await MemoryTool.call({ action: 'view' }, makeCtx());
    expect(result.data.ok).toBe(true);
    const json = JSON.stringify(result.data.result);
    expect(json).toContain('GLOBAL');
    expect(json).not.toContain('@project');
  });

  test('view MEMORY.md in project context → reads project file', async () => {
    replaceMemoryFile('MEMORY.md', 'GLOBAL', home);
    replaceProjectMemoryFile('proj1', 'PROJECT', home);
    const result = await MemoryTool.call(
      { action: 'view', file: 'MEMORY.md' },
      makeCtx(projectFixture),
    );
    const json = JSON.stringify(result.data.result);
    expect(json).toContain('PROJECT');
    expect(json).not.toContain('GLOBAL');
    expect(result.observation?.summary).toContain('scope=project');
  });

  test('view MEMORY.md with explicit scope: global in project context → reads global', async () => {
    replaceMemoryFile('MEMORY.md', 'GLOBAL', home);
    replaceProjectMemoryFile('proj1', 'PROJECT', home);
    const result = await MemoryTool.call(
      { action: 'view', file: 'MEMORY.md', scope: 'global' },
      makeCtx(projectFixture),
    );
    const json = JSON.stringify(result.data.result);
    expect(json).toContain('GLOBAL');
    expect(json).not.toContain('PROJECT');
    expect(result.observation?.summary).toContain('scope=global');
  });

  test('view USER.md is always global even with project scope', async () => {
    replaceMemoryFile('USER.md', 'USER GLOBAL', home);
    const result = await MemoryTool.call(
      { action: 'view', file: 'USER.md', scope: 'project' },
      makeCtx(projectFixture),
    );
    const json = JSON.stringify(result.data.result);
    expect(json).toContain('USER GLOBAL');
    expect(result.observation?.summary).toBe('viewed USER.md');
  });

  test('replace project content respects 2200-char cap', async () => {
    const big = 'x'.repeat(MEMORY_CAPS['MEMORY.md'] + 1);
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: big, scope: 'project' },
      makeCtx(projectFixture),
    );
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('rejected');
    expect(readProjectMemoryFile('proj1', home).content).toBe('');
  });

  test('affectedPaths reflects scope=project for MEMORY.md', () => {
    const paths = MemoryTool.affectedPaths?.({
      action: 'replace',
      file: 'MEMORY.md',
      content: 'x',
      scope: 'project',
    });
    expect(paths).toEqual(['memory/projects/MEMORY.md']);
  });

  test('affectedPaths reflects scope=global for MEMORY.md', () => {
    const paths = MemoryTool.affectedPaths?.({
      action: 'replace',
      file: 'MEMORY.md',
      content: 'x',
      scope: 'global',
    });
    expect(paths).toEqual(['memory/MEMORY.md']);
  });

  test('affectedPaths for USER.md is always memory/USER.md regardless of scope', () => {
    expect(
      MemoryTool.affectedPaths?.({
        action: 'replace',
        file: 'USER.md',
        content: 'x',
        scope: 'project',
      }),
    ).toEqual(['memory/USER.md']);
  });

  test('memory write hook fires on per-project replace with project metadata', async () => {
    let captured: object | undefined;
    const tctx = makeCtx(projectFixture);
    tctx.memoryManager = {
      async prefetchSnapshot() {
        return '';
      },
      async syncTurn() {},
      async onMemoryWrite(change) {
        captured = change;
      },
      async onDelegation() {},
    };
    const result = await MemoryTool.call(
      { action: 'replace', file: 'MEMORY.md', content: 'note' },
      tctx,
    );
    expect(result.observation?.status).toBe('success');
    expect(captured).toEqual({
      file: 'MEMORY.md',
      chars: 4,
      scope: 'project',
      projectId: 'proj1',
    });
  });
});
