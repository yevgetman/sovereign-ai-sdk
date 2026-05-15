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

  test('disposeSession closes the trace writer; file is finalized on disk', async () => {
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
      ctx.traceWriter.record({
        type: 'session_start',
        iso: new Date().toISOString(),
        sessionId,
        provider: 'mock',
        model: runtime.model,
        cwd: tmpHome,
      });

      const tracePath = ctx.traceWriter.path;
      await runtime.disposeSession(sessionId);

      expect(existsSync(tracePath)).toBe(true);
      const content = readFileSync(tracePath, 'utf8');
      expect(content).toContain('"type":"session_start"');

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

    const ctxA = runtime.getSessionContext(sessionA);
    const ctxB = runtime.getSessionContext(sessionB);

    ctxA.traceWriter.record({
      type: 'session_start',
      iso: new Date().toISOString(),
      sessionId: sessionA,
      provider: 'mock',
      model: runtime.model,
      cwd: tmpHome,
    });
    ctxB.traceWriter.record({
      type: 'session_start',
      iso: new Date().toISOString(),
      sessionId: sessionB,
      provider: 'mock',
      model: runtime.model,
      cwd: tmpHome,
    });

    await runtime.dispose();

    expect(existsSync(ctxA.traceWriter.path)).toBe(true);
    expect(existsSync(ctxB.traceWriter.path)).toBe(true);
    const contentA = readFileSync(ctxA.traceWriter.path, 'utf8');
    const contentB = readFileSync(ctxB.traceWriter.path, 'utf8');
    expect(contentA).toContain('"type":"session_start"');
    expect(contentB).toContain('"type":"session_start"');
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
