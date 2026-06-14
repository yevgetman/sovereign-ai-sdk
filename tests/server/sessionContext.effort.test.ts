// #14 — per-session /effort (backlog #57) must SURVIVE a compaction pivot.
//
// A long turn that crosses the proactive-compaction threshold mints a child
// session and the turns route pivots the active session onto it MID-TURN. The
// child's SessionContext is built fresh; before the #14 fix it re-seeded
// `effort: runtime.effort` (the boot default), silently dropping a `/effort
// high` the user set earlier — a mid-conversation regression vs the pre-#57
// shared global. These tests pin the inheritance: a compaction child inherits
// the parent's LIVE effort, while a fresh (parentless) session and an
// idle-rebuild (parent context evicted) fall back to the boot default.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';
import { resolveSeedEffort } from '../../src/server/sessionContext.js';

describe('SessionContext effort inheritance on compaction pivot (#14)', () => {
  let runtime: Runtime;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-effort-compact-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('a fresh (parentless) session seeds from the runtime boot default', () => {
    const parent = runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });
    expect(runtime.effort).toBe('off');
    expect(resolveSeedEffort(runtime, parent)).toBe('off');
    expect(runtime.getSessionContext(parent).effort).toBe('off');
  });

  test('a compaction child inherits the parent live effort, not the boot default', () => {
    // Parent session: user cranks /effort to high mid-conversation.
    const parent = runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });
    const parentCtx = runtime.getSessionContext(parent);
    parentCtx.effort = 'high';

    // Compaction mints a child row carrying parentSessionId, and the turns
    // route pivots onto it (parent context still live in the runtime map).
    const child = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      parentSessionId: parent,
    });

    // The seed helper resolves the parent's live effort...
    expect(resolveSeedEffort(runtime, child)).toBe('high');
    // ...and the built child context carries it, NOT the boot default 'off'.
    expect(runtime.getSessionContext(child).effort).toBe('high');
  });

  test('a compaction child of an EVICTED parent falls back to the boot default', () => {
    const parent = runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });
    const parentCtx = runtime.getSessionContext(parent);
    parentCtx.effort = 'max';

    const child = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      parentSessionId: parent,
    });

    // Evict the parent context (idle-eviction rebuild scenario): the live
    // effort is gone, so the child seeds from the boot default — documented,
    // acceptable for a UX-depth dial.
    runtime.sessionContexts.delete(parent);
    expect(resolveSeedEffort(runtime, child)).toBe('off');
  });

  test('inheritance chains across a second compaction pivot', () => {
    // /effort high on the root, then TWO compactions in one long conversation.
    const root = runtime.sessionDb.createSession({ model: 'mock-haiku', provider: 'mock' });
    runtime.getSessionContext(root).effort = 'high';

    const child1 = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      parentSessionId: root,
    });
    expect(runtime.getSessionContext(child1).effort).toBe('high');

    const child2 = runtime.sessionDb.createSession({
      model: 'mock-haiku',
      provider: 'mock',
      parentSessionId: child1,
    });
    // child2's parent (child1) is live and carries 'high' — it must propagate.
    expect(runtime.getSessionContext(child2).effort).toBe('high');
  });
});
