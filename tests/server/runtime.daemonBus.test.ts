// Phase 16.1 M7 T2 — DaemonEventBus plumbing in buildRuntime
// (closes backlog #28).
//
// Verifies that buildRuntime constructs a DaemonEventBus, exposes it on
// the Runtime surface, and threads the same instance into the TaskManager
// constructor so lifecycle events fire onto the shared bus.
//
// The unit-level "TaskManager → bus" semantics already live in
// tests/tasks/manager.bus.test.ts. This test focuses on the runtime-level
// wiring: that buildRuntime is what plumbs the bus, and that an external
// subscriber sees task_update events flow through the public surface.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonEventBus } from '../../src/daemon/eventBus.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — DaemonEventBus wired into TaskManager (M7 T2 / backlog #28)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t2-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'sov-m7-t2-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('Runtime exposes a DaemonEventBus instance', async () => {
    const runtime = await buildRuntime({
      cwd: tmpCwd,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      expect(runtime.daemonEventBus).toBeDefined();
      expect(runtime.daemonEventBus).toBeInstanceOf(DaemonEventBus);
    } finally {
      await runtime.dispose();
    }
  });

  test('TaskManager publishes task_update onto runtime.daemonEventBus during create()', async () => {
    const runtime = await buildRuntime({
      cwd: tmpCwd,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      // Subscribe BEFORE the state transition so the synchronous queued
      // event lands in `captured`.
      const captured: DaemonEvent[] = [];
      runtime.daemonEventBus.on('task_update', (evt) => {
        captured.push(evt);
      });

      // Seed a parent session so the FK constraint on tasks.parent_session_id
      // is satisfied.
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      // taskManager.create() emits task_update with state='queued'
      // synchronously (before scheduler.delegate is awaited), then kicks off
      // runDelegation in a fire-and-forget fashion. Whether the delegation
      // succeeds or fails in the background is orthogonal to the bus-wiring
      // assertion: the queued event has already fired by the time create()
      // returns. We use 'explore' (a real agent in bundle-default/agents/)
      // to keep the scheduler call survivable through to the queued emit;
      // any subsequent runDelegation failure is swallowed by safeEmit.
      const created = await runtime.taskManager.create({
        parentSessionId: sessionId,
        agentName: 'explore',
        prompt: 'noop',
        parentToolPool: runtime.toolPool,
        parentToolContext: {
          cwd: runtime.cwd,
          sessionId,
          harnessHome: runtime.harnessHome,
          agents: runtime.agents,
        },
      });

      // The queued event is synchronous; no wait needed.
      const queuedForThisTask = captured.filter(
        (e): e is Extract<DaemonEvent, { type: 'task_update' }> =>
          e.type === 'task_update' && e.taskId === created.id,
      );
      expect(queuedForThisTask.length).toBeGreaterThanOrEqual(1);
      expect(queuedForThisTask[0]?.state).toBe('queued');

      // Drain the fire-and-forget runDelegation before dispose() closes
      // sessionDb. The background work hits the mock provider with no
      // tool-using transcript; it'll resolve quickly either way.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await runtime.dispose();
    }
  });

  test('opts.daemonEventBus injection seam — caller-supplied bus is used and exposed', async () => {
    const injected = new DaemonEventBus();
    const runtime = await buildRuntime({
      cwd: tmpCwd,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
      daemonEventBus: injected,
    });

    try {
      expect(runtime.daemonEventBus).toBe(injected);
    } finally {
      await runtime.dispose();
    }
  });
});
