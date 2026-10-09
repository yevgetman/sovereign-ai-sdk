// Offline compiled-SDK native child context inheritance and tool-adjacency regression.
import assert from 'node:assert/strict';
import { LaneSemaphores, PathLockManager, SubagentScheduler, buildTool } from '@yevgetman/sov-sdk';
import { z } from 'zod';
let effects = 0;
const calls = [];
const reductions = [];
const use = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'child-call', name: 'Echo', input: {} }],
};
const answer = { role: 'assistant', content: [{ type: 'text', text: 'child done' }] };
const provider = {
  name: 'fixture',
  async *stream(req) {
    calls.push({ ...req, messages: structuredClone(req.messages) });
    const msg = calls.length === 1 ? use : answer;
    yield { type: 'message_start' };
    yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
    yield { type: 'message_stop', stop_reason: calls.length === 1 ? 'tool_use' : 'end_turn' };
    yield { type: 'assistant_message', message: msg };
    return msg;
  },
};
const manager = {
  async reduce(req) {
    reductions.push(req);
    return {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Earlier conversation summarized.' }] },
        ...req.messages.slice(-2),
      ],
      usage: { inputTokens: 5 },
      estimatedCostUsd: 0.01,
    };
  },
};
const child = {
  name: 'context-child',
  description: 'fixture child',
  systemPrompt: 'fixture',
  allowedTools: ['Echo'],
  maxTurns: 3,
  readOnly: true,
  supportsMissionState: false,
  inheritParentTools: false,
  allowedSubagents: [],
  path: '/tmp/context-child.md',
  realpath: '/tmp/context-child.md',
  dir: '/tmp',
  source: 'bundle',
  trustTier: 'builtin',
};
const scheduler = new SubagentScheduler({
  agents: { agents: [child], byName: new Map([[child.name, child]]) },
  laneSemaphores: new LaneSemaphores({}),
  pathLock: new PathLockManager(),
  resolveProvider: () => ({
    transport: provider,
    client: provider,
    baseUrl: 'fixture://',
    model: 'fixture',
    contextLength: 32000,
    authType: 'none',
    metadata: { provider: 'fixture' },
  }),
  createChildSession: () => 'packed-context-child',
  defaultProvider: 'fixture',
  defaultModel: 'fixture',
  maxTokens: 100,
  childPolicy: {
    inheritedConfig: { contextManager: manager, contextLimits: { maxHistoryBytes: 2000 } },
  },
});
const result = await scheduler.delegate({
  agentName: child.name,
  prompt: 'task '.repeat(200),
  parentSessionId: 'packed-context-parent',
  parentToolPool: [
    buildTool({
      name: 'Echo',
      description: () => 'fixture',
      inputSchema: z.object({}),
      async call() {
        effects++;
        return { data: { payload: 'x'.repeat(1400) } };
      },
    }),
  ],
  parentToolContext: { cwd: process.cwd(), sessionId: 'packed-context-parent' },
});
assert.equal(result.terminal.reason, 'completed');
assert.equal(effects, 1);
assert.equal(calls.length, 2);
assert.equal(reductions.length, 1);
assert.equal(reductions[0].reason, 'budget');
assert.equal(reductions[0].sessionId, 'packed-context-child');
assert.equal(calls[1].messages.at(-2).content[0].type, 'tool_use');
assert.equal(calls[1].messages.at(-1).content[0].type, 'tool_result');
assert.equal(result.usageComplete, true);
assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 4 });
console.log('CONTEXT_CHILD_OK');
