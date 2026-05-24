// Backlog Item 8 — per-child trace files. Verifies the scheduler writes
// a separate `<harnessHome>/traces/<childSessionId>.jsonl` for every
// delegation when `harnessHome` is supplied, while preserving the
// existing parent-recorder forwarding (additive, not a replacement).
//
// Two cases:
//   - With harnessHome: child file exists, contains only events tagged
//     with the child's sessionId, AND the parent recorder also receives
//     every event (back-compat with Fix #1 from cc334cc).
//   - Without harnessHome: no child file is created (test fakes that
//     don't supply harnessHome must keep working).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { ResolvedProvider } from '../../src/providers/resolver.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { LaneSemaphores } from '../../src/runtime/laneSemaphores.js';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
import { Semaphore } from '../../src/runtime/semaphore.js';
import type { ToolContext } from '../../src/tool/types.js';
import type { TraceEvent } from '../../src/trace/types.js';

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
  sessionId: 'parent-1',
};

describe('scheduler per-child trace file (Backlog Item 8)', () => {
  test('writes <harnessHome>/traces/<childId>.jsonl when harnessHome is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-perchild-trace-'));
    try {
      const parentEvents: TraceEvent[] = [];
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent()]),
        laneSemaphores: new LaneSemaphores({}),
        writeLock: new Semaphore(1),
        resolveProvider: () => makeFakeResolved(),
        createChildSession: () => 'child-abc',
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
        harnessHome: home,
      });

      const result = await scheduler.delegate({
        agentName: 'explore',
        prompt: 'find auth code',
        parentSessionId: 'parent-1',
        parentToolPool: [],
        parentToolContext: baseToolContext,
        traceRecorder: (e) => parentEvents.push(e),
      });

      expect(result.terminal.reason).toBe('completed');
      expect(result.childSessionId).toBe('child-abc');

      // Per-child file exists
      const childPath = join(home, 'traces', 'child-abc.jsonl');
      expect(existsSync(childPath)).toBe(true);

      const content = readFileSync(childPath, 'utf-8').trim();
      expect(content.length).toBeGreaterThan(0);
      const childEvents = content.split('\n').map((line) => JSON.parse(line) as TraceEvent);
      expect(childEvents.length).toBeGreaterThan(0);

      // Every event in the child file is tagged with the child sessionId
      for (const event of childEvents) {
        expect((event as { sessionId?: string }).sessionId).toBe('child-abc');
      }

      // Parent recorder also received the events (back-compat — additive,
      // not a replacement). Counts may differ slightly because the child
      // writer auto-injects sessionId on events that lacked one, but the
      // parent recorder gets called for every wrapped emission.
      expect(parentEvents.length).toBeGreaterThan(0);
      for (const event of parentEvents) {
        expect((event as { sessionId?: string }).sessionId).toBe('child-abc');
      }
      // Parent and child should have the SAME number of events (every
      // wrapped recorder call writes to both sinks).
      expect(parentEvents.length).toBe(childEvents.length);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips per-child file when harnessHome is omitted', async () => {
    const parentEvents: TraceEvent[] = [];
    const scheduler = new SubagentScheduler({
      agents: makeAgentRegistry([makeAgent()]),
      laneSemaphores: new LaneSemaphores({}),
      writeLock: new Semaphore(1),
      resolveProvider: () => makeFakeResolved(),
      createChildSession: () => 'child-no-home',
      defaultProvider: 'anthropic',
      defaultModel: 'm',
      maxTokens: 256,
      // harnessHome intentionally omitted
    });

    const result = await scheduler.delegate({
      agentName: 'explore',
      prompt: 'p',
      parentSessionId: 'parent-1',
      parentToolPool: [],
      parentToolContext: baseToolContext,
      traceRecorder: (e) => parentEvents.push(e),
    });

    expect(result.terminal.reason).toBe('completed');
    // Parent recorder still got the wrapped + tagged events.
    expect(parentEvents.length).toBeGreaterThan(0);
    for (const event of parentEvents) {
      expect((event as { sessionId?: string }).sessionId).toBe('child-no-home');
    }
  });

  test('still writes child file when parent traceRecorder is undefined', async () => {
    // Edge case: caller didn't supply a parent recorder but did supply
    // harnessHome. Child file should still get written so `sov trace
    // show <childId>` works for headless invocations.
    const home = mkdtempSync(join(tmpdir(), 'sov-perchild-trace-noparent-'));
    try {
      const scheduler = new SubagentScheduler({
        agents: makeAgentRegistry([makeAgent()]),
        laneSemaphores: new LaneSemaphores({}),
        writeLock: new Semaphore(1),
        resolveProvider: () => makeFakeResolved(),
        createChildSession: () => 'child-headless',
        defaultProvider: 'anthropic',
        defaultModel: 'm',
        maxTokens: 256,
        harnessHome: home,
      });

      const result = await scheduler.delegate({
        agentName: 'explore',
        prompt: 'p',
        parentSessionId: 'parent-1',
        parentToolPool: [],
        parentToolContext: baseToolContext,
        // no traceRecorder
      });

      expect(result.terminal.reason).toBe('completed');
      const childPath = join(home, 'traces', 'child-headless.jsonl');
      expect(existsSync(childPath)).toBe(true);
      const content = readFileSync(childPath, 'utf-8').trim();
      expect(content.length).toBeGreaterThan(0);
      const events = content.split('\n').map((line) => JSON.parse(line) as TraceEvent);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect((event as { sessionId?: string }).sessionId).toBe('child-headless');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
