// Phase 13.2 — end-to-end task lifecycle test. Uses the real SessionDb,
// TaskStore, TaskManager, and SubagentScheduler with a fake provider
// that returns a single completed assistant message after a controllable
// delay. Verifies queued -> running -> completed transitions, the
// child-session lineage, and cooperative cancellation.
//
// The fake provider listens for `req.signal.abort` so the cancellation
// test deterministically interrupts the in-flight stream rather than
// relying on between-turn signal polling alone.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { TaskManager } from '../../src/tasks/manager.js';
import { TaskStore } from '../../src/tasks/store.js';

function makeAgent(): AgentDefinition {
  return {
    name: 'explore',
    description: 'A test explore agent',
    systemPrompt: 'You are a test agent. Be concise.',
    allowedTools: [],
    maxTurns: 5,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents: [],
    path: '/tmp/explore.md',
    realpath: '/tmp/explore.md',
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
  };
}

function makeRegistry(): AgentRegistry {
  const agent = makeAgent();
  return { agents: [agent], byName: new Map([[agent.name, agent]]) };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'task complete' }],
};

/** Fake provider. When `holdMs > 0` it waits that long before yielding,
 *  and listens for `req.signal.abort` so cancellation rejects the wait
 *  instead of relying on between-turn polling. */
function makeFakeProvider(holdMs: number): LLMProvider {
  return {
    name: 'fake',
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      if (holdMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, holdMs);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'task complete' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: completedAnswer };
      return completedAnswer;
    },
  };
}

function makeResolved(holdMs = 0): ResolvedProvider {
  const transport = makeFakeProvider(holdMs);
  return {
    transport: transport as unknown as ResolvedProvider['transport'],
    client: transport,
    baseUrl: 'fake://',
    model: 'fake-model',
    contextLength: 32_000,
    authType: 'none',
    metadata: { provider: 'fake' },
  };
}

function setup(holdMs = 0): {
  db: SessionDb;
  manager: TaskManager;
  parentSessionId: string;
  baseCtx: ToolContext;
} {
  const db = SessionDb.open({ path: ':memory:' });
  const parentSessionId = db.createSession({ model: 'm', provider: 'p' });
  const scheduler = new SubagentScheduler({
    agents: makeRegistry(),
    laneSemaphores: new LaneSemaphores({}),
    pathLock: new PathLockManager(),
    resolveProvider: () => makeResolved(holdMs),
    createChildSession: (input) =>
      db.createSession({
        provider: input.provider,
        model: input.model,
        parentSessionId: input.parentSessionId,
        title: `subagent:${input.agentName}`,
        metadata: { agentName: input.agentName, kind: 'subagent' },
      }),
    defaultProvider: 'fake',
    defaultModel: 'fake-model',
    maxTokens: 1024,
  });
  const manager = new TaskManager({ store: new TaskStore(db), scheduler });
  return {
    db,
    manager,
    parentSessionId,
    baseCtx: { cwd: process.cwd(), sessionId: parentSessionId },
  };
}

describe('task lifecycle integration', () => {
  test('queued -> running -> completed with real scheduler + DB', async () => {
    const { db, manager, parentSessionId, baseCtx } = setup();
    const created = await manager.create({
      parentSessionId,
      agentName: 'explore',
      prompt: 'find auth',
      parentToolPool: [],
      parentToolContext: baseCtx,
    });
    expect(created.state).toBe('queued');

    // Wait for delegate() to fully resolve. The fake provider has
    // holdMs=0, so a few microtask drains plus a small setTimeout
    // suffice.
    await new Promise((r) => setTimeout(r, 20));
    const final = manager.get(created.id);
    expect(final?.state).toBe('completed');
    expect(final?.childSessionId).toBeDefined();
    expect(final?.resultPreview).toContain('task complete');

    // Verify the parent-child session lineage in the DB.
    const childSession = db.getSession(final?.childSessionId ?? '');
    expect(childSession?.parentSessionId).toBe(parentSessionId);
    db.close();
  });

  test('task_stop -> cancelled with real scheduler', async () => {
    // holdMs=200 keeps the fake provider in its stream() body long enough
    // for stop() to land before the answer would have completed. The
    // fake provider listens to req.signal.abort so the wait promise
    // rejects deterministically.
    const { db, manager, parentSessionId, baseCtx } = setup(200);
    const created = await manager.create({
      parentSessionId,
      agentName: 'explore',
      prompt: 'p',
      parentToolPool: [],
      parentToolContext: baseCtx,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.get(created.id)?.state).toBe('running');
    await manager.stop(created.id);
    await new Promise((r) => setTimeout(r, 50));
    const final = manager.get(created.id);
    expect(final?.state).toBe('cancelled');
    db.close();
  });
});
