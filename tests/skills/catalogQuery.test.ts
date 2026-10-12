import { expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { createSkillRegistryManager } from '@yevgetman/sov-sdk/skills/registry';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';
import { z } from 'zod';

const skill: Skill = {
  name: 'review',
  description: 'Inspect source changes',
  whenToUse: 'When asked to review a code patch',
  allowedTools: [],
  body: '',
  path: '',
  realpath: '',
  dir: '',
  source: 'bundle',
  trustTier: 'builtin',
  allowShellInterpolation: false,
  metadata: {
    harness: {
      requiresTools: [],
      requiresToolsets: [],
      fallbackForTools: [],
      fallbackForToolsets: [],
    },
  },
  guard: { action: 'allow', findings: [] },
};
const record = (window: number): ModelRecord => ({
  id: 'future',
  displayName: 'Future',
  provider: 'fixture',
  routeId: 'fixture',
  auth: 'custom',
  capabilities: {
    textOutput: 'supported',
    tools: 'supported',
    images: 'unsupported',
    reasoning: 'unsupported',
  },
  contextWindow: window,
  maxOutputTokens: 128,
  availability: 'unknown',
  metadata: { source: 'fixture', stale: false },
});

test('host input token accounting keeps catalogs reachable when the byte fallback overestimates history', async () => {
  const registry = { skills: [skill], byName: new Map([[skill.name, skill]]) };
  const manager = createSkillRegistryManager({
    load: async () => ({ registry }),
    initial: { registry },
  });
  const requests: ProviderRequest[] = [];
  const pages: Awaited<ReturnType<typeof SkillsListTool.call>>['data'][] = [];
  const list = {
    ...SkillsListTool,
    call: async (...args: Parameters<typeof SkillsListTool.call>) => {
      const result = await SkillsListTool.call(...args);
      pages.push(result.data);
      return result;
    },
  };
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      requests.push(request);
      const message: AssistantMessage = {
        role: 'assistant',
        content:
          requests.length === 1
            ? [{ type: 'tool_use', id: 'host-accounted-list', name: 'skills_list', input: {} }]
            : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn' };
      return message;
    },
  };
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(210_000) }] },
  ];
  let countedStanding = false;
  const loop = query({
    provider,
    model: 'future',
    modelMetadata: record(200_000),
    maxTokens: 128,
    messages: history,
    systemPrompt: [{ text: 'Standing host guidance.', cacheable: true }],
    tools: [list as unknown as Tool<unknown, unknown>],
    toolContext: { cwd: '/', sessionId: 'host-counted-catalog', skillRegistryManager: manager },
    inputTokenCounter: (request) => {
      expect(request.modelMetadata?.contextWindow).toBe(200_000);
      expect(request.tools?.[0]?.name).toBe('skills_list');
      expect(request.system[0]?.text).toBe('Standing host guidance.');
      if (!request.system.some((segment) => segment.kind === 'skill-catalog'))
        countedStanding = true;
      return Math.ceil(Buffer.byteLength(JSON.stringify(request.messages)) / 4) + 1_000;
    },
    canUseTool: async () => ({ behavior: 'allow' }),
  });
  for (;;) {
    const next = await loop.next();
    if (next.done) {
      expect(next.value.reason).toBe('completed');
      break;
    }
  }
  expect(countedStanding).toBe(true);
  expect(requests[0]?.system.find((segment) => segment.kind === 'skill-catalog')?.text).toContain(
    '"name":"review"',
  );
  expect(pages[0]?.budgetExhausted).toBeUndefined();
  expect(pages[0]?.skills.map((entry) => entry.name)).toEqual(['review']);

  // Without an explicit counter the conservative byte bound still prevents
  // provider work; catalog accounting must not weaken request admission.
  const fallback = query({
    provider,
    model: 'future',
    modelMetadata: record(200_000),
    maxTokens: 128,
    messages: history,
    systemPrompt: [],
    tools: [list as unknown as Tool<unknown, unknown>],
    toolContext: { cwd: '/', sessionId: 'fallback-catalog', skillRegistryManager: manager },
  });
  for (;;) {
    const next = await fallback.next();
    if (next.done) {
      expect(next.value.reason).toBe('error');
      break;
    }
  }
  expect(requests).toHaveLength(2);
});

test('invalid or failing host counters stop catalog-enabled requests before provider work', async () => {
  const registry = { skills: [skill], byName: new Map([[skill.name, skill]]) };
  const manager = createSkillRegistryManager({
    load: async () => ({ registry }),
    initial: { registry },
  });
  let providerCalls = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream() {
      providerCalls++;
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'unexpected' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const counters = [
    () => Number.NaN,
    () => -1,
    () => {
      throw new Error('counter failed');
    },
  ];
  for (const inputTokenCounter of counters) {
    const loop = query({
      provider,
      model: 'future',
      modelMetadata: record(200_000),
      maxTokens: 128,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Review this patch.' }] }],
      systemPrompt: [],
      tools: [SkillsListTool as unknown as Tool<unknown, unknown>],
      toolContext: { cwd: '/', sessionId: 'invalid-counter', skillRegistryManager: manager },
      inputTokenCounter,
    });
    for (;;) {
      const next = await loop.next();
      if (next.done) {
        expect(next.value.reason).toBe('error');
        break;
      }
    }
  }
  expect(providerCalls).toBe(0);
});

test('successful history reduction restores catalog pages and later tool growth reduces their budget', async () => {
  const registry = { skills: [skill], byName: new Map([[skill.name, skill]]) };
  const manager = createSkillRegistryManager({
    load: async () => ({ registry }),
    initial: { registry },
  });
  const budgets: number[] = [];
  const pages: number[] = [];
  const list = {
    ...SkillsListTool,
    call: async (...args: Parameters<typeof SkillsListTool.call>) => {
      budgets.push(args[1].skillContextBudget?.pageTokens ?? -1);
      const result = await SkillsListTool.call(...args);
      pages.push(result.data.skills.length);
      return result;
    },
  };
  const grow = buildTool<unknown, unknown>({
    name: 'Grow',
    description: () => 'Public history fixture',
    inputSchema: z.unknown(),
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => ({ data: 'G'.repeat(8_000) }),
  });
  let calls = 0;
  let reductions = 0;
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      const names = ['skills_list', 'Grow', 'skills_list'];
      const name = names[calls++];
      const message: AssistantMessage = {
        role: 'assistant',
        content: name
          ? [{ type: 'tool_use', id: `catalog-${calls}`, name, input: {} }]
          : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: name ? 'tool_use' : 'end_turn' };
      return message;
    },
  };
  const latest: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Find the review workflow.' }],
  };
  const generator = query({
    provider,
    model: 'future',
    modelMetadata: record(32_768),
    maxTokens: 128,
    maxTurns: 5,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old'.repeat(20_000) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier.' }] },
      latest,
    ],
    systemPrompt: [],
    tools: [list as unknown as Tool<unknown, unknown>, grow],
    toolContext: { cwd: '/', sessionId: 'catalog-reduction', skillRegistryManager: manager },
    canUseTool: async () => ({ behavior: 'allow' }),
    contextLimits: { maxHistoryBytes: 20_000, contextWindowTokens: 32_768 },
    contextManager: {
      reduce: async () => {
        reductions++;
        return { messages: [latest] };
      },
    },
  });
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      expect(next.value.reason).toBe('completed');
      break;
    }
  }
  expect(reductions).toBe(1);
  expect(pages).toEqual([1, 1]);
  expect(budgets[0]).toBeGreaterThan(0);
  expect(budgets[1]).toBeLessThan(budgets[0] ?? 0);
  expect(requests[0]?.system.find((segment) => segment.kind === 'skill-catalog')?.text).toContain(
    'review',
  );
});

test('query catalogs use frozen effective limits, preserve host guidance and re-budget on next turn', async () => {
  const calls: ProviderRequest[] = [];
  const registry = { skills: [skill], byName: new Map([[skill.name, skill]]) };
  const manager = createSkillRegistryManager({
    load: async () => ({ registry }),
    initial: { registry },
  });
  const metadata = record(200_000);
  let count = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      calls.push(request);
      const message: AssistantMessage =
        count++ === 0
          ? {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'list-one', name: 'skills_list', input: {} }],
            }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      metadata.contextWindow = 4_096;
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: count === 1 ? 'tool_use' : 'end_turn' };
      return message;
    },
  };
  const run = async () => {
    const loop = query({
      provider,
      model: metadata.id,
      modelMetadata: metadata,
      maxTokens: 128,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Review my patch' }] }],
      systemPrompt: [
        { text: '<skills>Host standing guidance must remain intact.</skills>', cacheable: true },
        { text: 'stale generated metadata', cacheable: true, kind: 'skill-catalog' },
      ],
      tools: [SkillsListTool as unknown as Tool<unknown, unknown>],
      toolContext: { cwd: '/', sessionId: 'catalog-fixture', skillRegistryManager: manager },
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    for (;;) {
      const next = await loop.next();
      if (next.done) return next.value;
    }
  };
  expect((await run()).reason).toBe('completed');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.system.map((s) => s.text).join('\n')).toContain('Host standing guidance');
  expect(calls[0]?.system.map((s) => s.text).join('\n')).not.toContain('stale generated');
  expect(calls[0]?.system.find((s) => s.kind === 'skill-catalog')?.text).toContain(
    '"name":"review"',
  );
  expect(calls[1]?.system).toEqual(calls[0]?.system);
  expect(calls[1]?.modelMetadata?.contextWindow).toBe(200_000);
  expect((await run()).reason).toBe('completed');
  expect(calls[2]?.system.find((s) => s.kind === 'skill-catalog')).toBeUndefined();
  expect(calls[2]?.modelMetadata?.contextWindow).toBe(4_096);
});
