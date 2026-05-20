// Backlog #43 (closed 2026-05-19) — server-side memory manager wire-up.
//
// The server's SessionContext owns a per-session memoryManager +
// projectScope and threads them onto every turn's ToolContext:
//   1. buildSessionContext constructs both and stores them on the
//      SessionContext.
//   2. buildSessionToolContext threads the SAME references (not copies)
//      onto each ToolContext so MemoryTool's
//      `ctx.memoryManager?.onMemoryWrite(...)` notifications fire and
//      `ctx.projectScope` routes writes to the correct global/per-project
//      MEMORY.md.
//   3. disposeSessionContext calls onSessionEnd + shutdown to drain
//      provider state (no-op for the built-in markdown provider, but
//      structurally correct for non-builtins).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('SessionContext memory manager + project scope (backlog #43)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m43-memory-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('SessionContext exposes memoryManager and projectScope', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.memoryManager).toBeDefined();
      expect(ctx.projectScope).toBeDefined();
      // Scope shape depends on the running environment (whether git
      // walks up and finds a remote). Both 'project' and 'none' are
      // valid; assert the discriminator is one of them and the project
      // form carries id+name.
      const validKinds = ['project', 'none'];
      expect(validKinds).toContain(ctx.projectScope.kind);
      if (ctx.projectScope.kind === 'project') {
        expect(typeof ctx.projectScope.id).toBe('string');
        expect(ctx.projectScope.id.length).toBeGreaterThan(0);
        expect(typeof ctx.projectScope.name).toBe('string');
      }
    } finally {
      await runtime.dispose();
    }
  });

  test('buildSessionToolContext threads the same memoryManager + projectScope references', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });
      const ctx = runtime.getSessionContext(sessionId);

      // MemoryTool.onMemoryWrite + projectScope routing both depend on the
      // ToolContext fields being the SAME instances as the SessionContext
      // — not fresh copies on every turn.
      const sessionCanUseTool = async (): Promise<{
        behavior: 'allow';
        updatedInput: unknown;
      }> => ({ behavior: 'allow', updatedInput: {} });
      const toolCtx = buildSessionToolContext(runtime, sessionId, sessionCanUseTool);
      expect(toolCtx.memoryManager).toBe(ctx.memoryManager);
      expect(toolCtx.projectScope).toBe(ctx.projectScope);
    } finally {
      await runtime.dispose();
    }
  });

  test('memoryManager exposes the MemoryRuntime surface MemoryTool depends on', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });
      const ctx = runtime.getSessionContext(sessionId);

      // Sanity-check that the manager honors the MemoryRuntime contract.
      // Concrete MemoryTool call sites use these methods optional-chain;
      // even passing through to no-op providers, none should throw.
      await expect(
        ctx.memoryManager.onMemoryWrite({ file: 'MEMORY.md', chars: 0 }),
      ).resolves.toBeUndefined();
      await expect(ctx.memoryManager.syncTurn('u', 'a')).resolves.toBeUndefined();
      await expect(ctx.memoryManager.onDelegation('task', 'result')).resolves.toBeUndefined();
      const snapshot = await ctx.memoryManager.prefetchSnapshot('hello');
      expect(typeof snapshot).toBe('string');
    } finally {
      await runtime.dispose();
    }
  });
});
