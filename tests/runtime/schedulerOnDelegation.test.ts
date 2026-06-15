// Phase 13.6 — on_delegation hook + parent-child DB lineage. Verifies
// the scheduler invokes parent.memoryManager.onDelegation(task, result)
// after successful child completion, skips the hook on error/interrupt,
// and that errors in the hook don't break the scheduler return path.
//
// Also confirms parent-child lineage flows through the live SessionDb
// when the REPL's createChildSession callback (db.createSession with
// parentSessionId) is wired up — guard against any future regression
// where the lineage column gets dropped on the write path.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDb } from '../../src/agent/sessionDb.js';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { MemoryRuntime } from '../../src/memory/provider.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { PathLockManager } from '../../src/runtime/pathLock.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import type { ToolContext } from '../../src/tool/types.js';

function makeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'explore',
    description: 'test agent',
    systemPrompt: 'be terse',
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
    ...over,
  };
}

function makeAgentRegistry(agents: AgentDefinition[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const a of agents) byName.set(a.name, a);
  return { agents: [...agents], byName };
}

const summary: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'task complete' }],
};

function completedTurn(): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text: 'task complete' },
    { type: 'message_stop', stop_reason: 'end_turn' },
    { type: 'assistant_message', message: summary },
  ];
}

function makeFakeResolved(): ResolvedProvider {
  const transport: LLMProvider = {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      for (const ev of completedTurn()) yield ev;
      return summary;
    },
  };
  return {
    transport: transport as unknown as ResolvedProvider['transport'],
    client: transport,
    baseUrl: 'fake://',
    model: 'm',
    contextLength: 32_000,
    authType: 'none',
    metadata: { provider: 'fake' },
  };
}

const baseToolContext: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'parent',
};

describe('scheduler on_delegation hook', () => {
  test('calls memoryManager.onDelegation(prompt, summary) after success', async () => {
    const calls: Array<{ task: string; result: string }> = [];
    const memoryManager: MemoryRuntime = {
      async prefetchSnapshot() {
        return '';
      },
      async syncTurn() {},
      async onMemoryWrite() {},
      async onDelegation(task, result) {
        calls.push({ task, result });
      },
    };
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved(),
      createChildSession: () => 'child-1',
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    await scheduler.delegate({
      agentName: 'explore',
      prompt: 'find auth code',
      parentSessionId: 'parent',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      memoryManager,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe('find auth code');
    expect(calls[0]?.result).toBe('task complete');
  });

  test('skips onDelegation when terminal is interrupted', async () => {
    let calls = 0;
    const memoryManager: MemoryRuntime = {
      async prefetchSnapshot() {
        return '';
      },
      async syncTurn() {},
      async onMemoryWrite() {},
      async onDelegation() {
        calls++;
      },
    };
    const ctl = new AbortController();
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => ({
        transport: {
          name: 'hang',
          async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
            yield { type: 'message_start' };
            await new Promise((_resolve, reject) => {
              ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            });
            return { role: 'assistant', content: [] };
          },
        } as unknown as ResolvedProvider['transport'],
        client: {},
        baseUrl: 'fake://',
        model: 'm',
        contextLength: 32_000,
        authType: 'none',
        metadata: { provider: 'anthropic' },
      }),
      createChildSession: () => 'child',
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    setTimeout(() => ctl.abort(), 5);
    await scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent',
      parentSignal: ctl.signal,
      parentToolPool: [],
      parentToolContext: baseToolContext,
      memoryManager,
    });
    expect(calls).toBe(0);
  });

  test('hook errors do not propagate up — they route to traceRecorder', async () => {
    const memoryManager: MemoryRuntime = {
      async prefetchSnapshot() {
        return '';
      },
      async syncTurn() {},
      async onMemoryWrite() {},
      async onDelegation() {
        throw new Error('memory provider exploded');
      },
    };
    const traces: unknown[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved(),
      createChildSession: () => 'child',
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
    });
    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      memoryManager,
      traceRecorder: (e) => traces.push(e),
    });
    // Scheduler returns the successful result even though the hook threw.
    expect(result.terminal.reason).toBe('completed');
    expect(result.summary).toBe('task complete');
    // The error landed on the trace stream.
    expect(
      traces.some(
        (t) =>
          typeof t === 'object' &&
          t !== null &&
          'op' in t &&
          (t as { op: string }).op === 'onDelegation',
      ),
    ).toBe(true);
  });
});

describe('scheduler child trajectory capture', () => {
  test('successful child writes a standalone samples.jsonl record', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sov-child-traj-'));
    try {
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent()]),
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => makeFakeResolved(),
        createChildSession: () => 'child-traj-1',
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
        artifactsRoot: tmpDir,
      });
      await scheduler.delegate({
        agentName: 'explore',
        prompt: 'find auth code',
        parentSessionId: 'parent',
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      const samplesPath = join(tmpDir, 'trajectories', 'samples.jsonl');
      const failedPath = join(tmpDir, 'trajectories', 'failed.jsonl');
      const fs = await import('node:fs/promises');
      const samples = await fs.readFile(samplesPath, 'utf8');
      expect(samples).toContain('"sessionId":"child-traj-1"');
      // Successful run should NOT have written to failed.jsonl.
      const failedExists = await fs
        .access(failedPath)
        .then(() => true)
        .catch(() => false);
      expect(failedExists).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('errored child writes to failed.jsonl, not samples.jsonl', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sov-child-traj-fail-'));
    try {
      // Provider that emits a message_start so AgentRunner appends a
      // (synthetic) turn to messages, then aborts via the parent
      // signal — the child terminates with reason=interrupted, which
      // bucket-splits to failed.jsonl.
      const ctl = new AbortController();
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent()]),
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => ({
          transport: {
            name: 'hang-then-abort',
            async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
              yield { type: 'message_start' };
              await new Promise((_resolve, reject) => {
                ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
              });
              return { role: 'assistant', content: [] };
            },
          } as unknown as ResolvedProvider['transport'],
          client: {},
          baseUrl: 'fake://',
          model: 'm',
          contextLength: 32_000,
          authType: 'none',
          metadata: { provider: 'anthropic' },
        }),
        createChildSession: () => 'child-fail-1',
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
        artifactsRoot: tmpDir,
      });
      setTimeout(() => ctl.abort(), 5);
      await scheduler.delegate({
        agentName: 'explore',
        prompt: 'will be cancelled',
        parentSessionId: 'parent',
        parentSignal: ctl.signal,
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      const samplesPath = join(tmpDir, 'trajectories', 'samples.jsonl');
      const failedPath = join(tmpDir, 'trajectories', 'failed.jsonl');
      const fs = await import('node:fs/promises');
      // failed.jsonl should exist with the child's session id
      const failed = await fs.readFile(failedPath, 'utf8').catch(() => '');
      expect(failed).toContain('"sessionId":"child-fail-1"');
      // samples.jsonl should NOT contain the failed child's record
      const samplesExists = await fs
        .access(samplesPath)
        .then(() => true)
        .catch(() => false);
      if (samplesExists) {
        const samples = await fs.readFile(samplesPath, 'utf8');
        expect(samples).not.toContain('"sessionId":"child-fail-1"');
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('skips child trajectory write when artifactsRoot is omitted', async () => {
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => makeFakeResolved(),
      createChildSession: () => 'child-no-traj',
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
      // artifactsRoot intentionally omitted
    });
    // Should complete without throwing or writing anything.
    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent',
      parentToolPool: [],
      parentToolContext: baseToolContext,
    });
    expect(result.terminal.reason).toBe('completed');
  });
});

describe('scheduler parent-child DB lineage (integration)', () => {
  test('createChildSession via db.createSession persists parent_session_id', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sov-scheduler-lineage-'));
    try {
      const db = SessionDb.open({ path: join(tmpDir, 'sessions.db') });
      const parentSessionId = db.createSession({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent()]),
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => makeFakeResolved(),
        createChildSession: (input) =>
          db.createSession({
            provider: input.provider,
            model: input.model,
            parentSessionId: input.parentSessionId,
            title: `subagent:${input.agentName}`,
            metadata: { agentName: input.agentName, kind: 'subagent' },
          }),
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
      });
      const result = await scheduler.delegate({
        agentName: 'explore',
        prompt: 'find auth code',
        parentSessionId,
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      const child = db.getSession(result.childSessionId);
      expect(child).toBeTruthy();
      expect(child?.parentSessionId).toBe(parentSessionId);
      expect(child?.title).toBe('subagent:explore');
      const meta = child?.metadata as { agentName?: string; kind?: string };
      expect(meta?.agentName).toBe('explore');
      expect(meta?.kind).toBe('subagent');
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('two delegations from the same parent both link via parent_session_id', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sov-scheduler-lineage-multi-'));
    try {
      const db = SessionDb.open({ path: join(tmpDir, 'sessions.db') });
      const parentSessionId = db.createSession({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent({ name: 'explore' }), makeAgent({ name: 'verify' })]),
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => makeFakeResolved(),
        createChildSession: (input) =>
          db.createSession({
            provider: input.provider,
            model: input.model,
            parentSessionId: input.parentSessionId,
            title: `subagent:${input.agentName}`,
          }),
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
      });
      const r1 = await scheduler.delegate({
        agentName: 'explore',
        prompt: 'a',
        parentSessionId,
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      const r2 = await scheduler.delegate({
        agentName: 'verify',
        prompt: 'b',
        parentSessionId,
        parentToolPool: [],
        parentToolContext: baseToolContext,
      });
      expect(r1.childSessionId).not.toBe(r2.childSessionId);
      expect(db.getSession(r1.childSessionId)?.parentSessionId).toBe(parentSessionId);
      expect(db.getSession(r2.childSessionId)?.parentSessionId).toBe(parentSessionId);
      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
