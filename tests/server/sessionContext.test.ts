// Phase 16.1 M7 T3 — per-session subsystem registry.
//
// SessionContext holds per-session subsystems (TraceWriter today; learning
// observer + review manager + trajectory metadata in T4-T6). Runtime.
// getSessionContext is a lazy-build + cache; disposeSession evicts. This
// suite pins the contract around the TraceWriter wiring only — the
// extension-point fields land empty in T3 by design.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('SessionContext lifecycle (M7 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t3-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('getSessionContext returns a populated context with a TraceWriter', async () => {
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
      expect(ctx).toBeDefined();
      expect(ctx.sessionId).toBe(sessionId);
      expect(ctx.traceWriter).toBeDefined();
      // Default path is <harnessHome>/traces/<sessionId>.jsonl.
      expect(ctx.traceWriter.path).toContain(sessionId);
      expect(ctx.traceWriter.path).toContain(tmpHome);

      // Cached: second call returns the same instance.
      const ctx2 = runtime.getSessionContext(sessionId);
      expect(ctx2).toBe(ctx);
    } finally {
      await runtime.dispose();
    }
  });

  test('disposeSession closes the trace writer; auto-emitted session_start + session_end are finalized on disk', async () => {
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

      // Whole-branch review I3 — `session_start` is now auto-emitted by
      // buildSessionContext; the test no longer manually injects it. The
      // closing `session_end` is auto-emitted by disposeSessionContext
      // BEFORE traceWriter.close(). Both lines must land in the JSONL.
      const ctx = runtime.getSessionContext(sessionId);

      const tracePath = ctx.traceWriter.path;
      await runtime.disposeSession(sessionId);

      expect(existsSync(tracePath)).toBe(true);
      const content = readFileSync(tracePath, 'utf8');
      expect(content).toContain('"type":"session_start"');
      expect(content).toContain('"type":"session_end"');

      // After dispose, the session context is evicted: getSessionContext
      // rebuilds a fresh instance.
      const ctx2 = runtime.getSessionContext(sessionId);
      expect(ctx2).not.toBe(ctx);
    } finally {
      await runtime.dispose();
    }
  });

  test('runtime.dispose() walks live sessionContexts and disposes each', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    const sessionA = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    const sessionB = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    // Whole-branch review I3 — buildSessionContext auto-emits session_start
    // immediately. No manual record() call needed; runtime.dispose() walks
    // both contexts via disposeSessionContext which auto-emits session_end
    // before traceWriter.close(). Both bookend events land in the JSONL.
    const ctxA = runtime.getSessionContext(sessionA);
    const ctxB = runtime.getSessionContext(sessionB);

    await runtime.dispose();

    expect(existsSync(ctxA.traceWriter.path)).toBe(true);
    expect(existsSync(ctxB.traceWriter.path)).toBe(true);
    const contentA = readFileSync(ctxA.traceWriter.path, 'utf8');
    const contentB = readFileSync(ctxB.traceWriter.path, 'utf8');
    expect(contentA).toContain('"type":"session_start"');
    expect(contentA).toContain('"type":"session_end"');
    expect(contentB).toContain('"type":"session_start"');
    expect(contentB).toContain('"type":"session_end"');
  });

  test('double-dispose is idempotent', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    runtime.getSessionContext(sessionId);
    await runtime.disposeSession(sessionId);
    // Second call must not throw — eviction already happened.
    await runtime.disposeSession(sessionId);
    await runtime.dispose();
  });
});
