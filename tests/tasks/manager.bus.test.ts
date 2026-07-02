// Verifies Phase 16.0b build item 2: TaskManager pushes lifecycle
// transitions to the daemon event bus when one is supplied.
//
// Note on stub shape: the spec's example uses a minimal fake scheduler;
// the real DelegateResult has more required fields and the FK from
// tasks.child_session_id -> sessions.session_id must be satisfied
// before the terminal write lands. We mirror tests/tasks/manager.test.ts
// for that scaffolding (SessionDb.open + seedChildSession) while keeping
// the assertion shape exactly as specified.

import { describe, expect, it } from 'bun:test';
import type { Terminal } from '@yevgetman/sov-sdk/core/types';
import type { DelegateInput, DelegateResult } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { DaemonEventBus } from '../../src/daemon/eventBus.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { TaskStore } from '../../src/tasks/store.js';
import type { CreateTaskInput } from '../../src/tasks/types.js';

const baseToolContext: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };

function seedChildSession(db: SessionDb, childId: string): void {
  const now = Date.now() / 1000;
  db.handle.run(
    `INSERT INTO sessions (
      session_id, model, provider, platform, created_at, last_updated,
      schema_version, metadata
    ) VALUES (?, 'm', 'p', 'cli', ?, ?, 4, '{}')`,
    [childId, now, now],
  );
}

function fakeScheduler(db: SessionDb, childId: string): SubagentScheduler {
  return {
    delegate: async (_input: DelegateInput): Promise<DelegateResult> => {
      seedChildSession(db, childId);
      const terminal: Terminal = { reason: 'completed' };
      return {
        childSessionId: childId,
        agentName: 'explore',
        resolvedProvider: 'fake',
        resolvedModel: 'fake-model',
        terminal,
        summary: 'ok',
        iterationsUsed: 1,
        toolCallCount: 0,
        distinctToolNames: [],
        durationMs: 5,
      };
    },
  } as unknown as SubagentScheduler;
}

function makeStore(): { db: SessionDb; store: TaskStore; sessionId: string; cleanup: () => void } {
  const db = SessionDb.open({ path: ':memory:' });
  const sessionId = db.createSession({ model: 'm', provider: 'p' });
  const store = new TaskStore(db);
  return {
    db,
    store,
    sessionId,
    cleanup: (): void => db.close(),
  };
}

describe('TaskManager → bus', () => {
  it('emits task_update on queue and on terminal state', async () => {
    const { db, store, sessionId, cleanup } = makeStore();
    try {
      const bus = new DaemonEventBus();
      const events: DaemonEvent[] = [];
      bus.on('task_update', (e) => events.push(e));

      const tm = new TaskManager({ store, scheduler: fakeScheduler(db, 'child-bus-1'), bus });
      const input: CreateTaskInput = {
        parentSessionId: sessionId,
        agentName: 'explore',
        prompt: 'test',
        parentToolPool: [],
        parentToolContext: baseToolContext,
      };
      const created = await tm.create(input);

      // Allow async delegate() to resolve
      await new Promise((r) => setTimeout(r, 10));

      const updates = events.filter(
        (e): e is Extract<DaemonEvent, { type: 'task_update' }> =>
          e.type === 'task_update' && e.taskId === created.id,
      );
      // Queue event + terminal event
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0]?.state).toBe('queued');
      expect(updates.at(-1)?.state).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('does not throw when no bus is supplied', async () => {
    const { db, store, sessionId, cleanup } = makeStore();
    try {
      const tm = new TaskManager({ store, scheduler: fakeScheduler(db, 'child-bus-2') });
      const created = await tm.create({
        parentSessionId: sessionId,
        agentName: 'explore',
        prompt: 'p',
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      expect(created.id).toBeDefined();
      // Drain fire-and-forget so db.close doesn't race with the terminal write.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      cleanup();
    }
  });
});
