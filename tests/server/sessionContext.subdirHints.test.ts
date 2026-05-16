// Phase 16.1 M8 T3 — per-session subdirectory-hint state.
//
// terminalRepl.ts threads a fresh `createSubdirectoryHintState()` onto every
// turn's ToolContext so the orchestrator's `appendSubdirectoryHints` call
// (src/core/orchestrator.ts:640-653) fires after every tool result. The
// server's SessionContext now mirrors that wiring:
//   1. `buildSessionContext` constructs a state and attaches it to the
//      SessionContext under `subdirectoryHintState`.
//   2. `buildSessionToolContext` threads the same reference (not a copy)
//      onto every ToolContext built for the session — so the state
//      persists across the turn's tool loop and orchestrator dedup works.
//
// The orchestrator side is already wired; populating the ToolContext field
// is the load-bearing assertion this suite pins.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('SessionContext.subdirectoryHintState (M8 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t3-hint-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('SessionContext exposes subdirectoryHintState with empty touched set', async () => {
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
      expect(ctx.subdirectoryHintState).toBeDefined();
      expect(ctx.subdirectoryHintState.touched).toBeInstanceOf(Set);
      expect(ctx.subdirectoryHintState.touched.size).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('buildSessionToolContext threads the SessionContext subdirectoryHintState reference', async () => {
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

      // The same reference must reach ToolContext — orchestrator's dedup
      // semantics depend on a single shared Set per session.
      const sessionCanUseTool = async (): Promise<{
        behavior: 'allow';
        updatedInput: unknown;
      }> => ({ behavior: 'allow', updatedInput: {} });
      const toolCtx = buildSessionToolContext(runtime, sessionId, sessionCanUseTool);
      expect(toolCtx.subdirectoryHintState).toBe(ctx.subdirectoryHintState);
    } finally {
      await runtime.dispose();
    }
  });
});
