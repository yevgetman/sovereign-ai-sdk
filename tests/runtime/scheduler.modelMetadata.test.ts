import { expect, test } from 'bun:test';
import { LaneSemaphores, PathLockManager, SubagentScheduler } from '@yevgetman/sov-sdk';
import type { AgentDefinition, AssistantMessage, ProviderRequest } from '@yevgetman/sov-sdk';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';

const definition: AgentDefinition = {
  name: 'worker',
  description: 'test',
  systemPrompt: 'worker',
  allowedTools: [],
  maxTurns: 2,
  readOnly: true,
  supportsMissionState: false,
  inheritParentTools: false,
  allowedSubagents: [],
  path: '/tmp/worker',
  realpath: '/tmp/worker',
  dir: '/tmp',
  source: 'bundle',
  trustTier: 'builtin',
};
test('child catalog port binds each exact child and never inherits parent model evidence', async () => {
  const requests: ProviderRequest[] = [];
  const calls: string[][] = [];
  const record = {
    ...findModel(fallbackModelCatalog('openrouter-api'), 'vendor/child'),
    contextWindow: 8_000_000,
    maxOutputTokens: 2000,
    capabilities: {
      textOutput: 'supported' as const,
      tools: 'unknown' as const,
      images: 'unsupported' as const,
      reasoning: 'unknown' as const,
    },
    metadata: { source: 'fixture', stale: false },
    pricing: {
      state: 'paid' as const,
      currency: 'USD' as const,
      source: 'fixture',
      inputPerMillion: 1,
      outputPerMillion: 2,
    },
  };
  const parentRecord = { ...record, id: 'vendor/parent', contextWindow: 10 };
  const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  const provider = {
    name: 'openrouter',
    async *stream(req: ProviderRequest) {
      requests.push(req);
      yield { type: 'assistant_message' as const, message: answer };
      yield { type: 'usage_delta' as const, usage: { inputTokens: 5, outputTokens: 3 } };
      yield { type: 'message_stop' as const, stop_reason: 'end_turn' as const };
      return answer;
    },
  };
  const scheduler = new SubagentScheduler({
    agents: { agents: [definition], byName: new Map([['worker', definition]]) },
    laneSemaphores: new LaneSemaphores({}),
    pathLock: new PathLockManager(),
    resolveProvider: () => ({
      transport: provider as never,
      client: {},
      baseUrl: 'fake://',
      model: 'vendor/child',
      contextLength: 128_000,
      authType: 'none',
      metadata: {},
    }),
    resolveModelMetadata: (provider, model) => {
      calls.push([provider, model]);
      return record;
    },
    createChildSession: () => `child-${calls.length}`,
    defaultProvider: 'openrouter',
    defaultModel: 'vendor/child',
    maxTokens: 4000,
    childPolicy: { inheritedConfig: { modelMetadata: parentRecord } },
  });
  for (const contextWindow of [8_000_000, 1_000_000]) {
    record.contextWindow = contextWindow;
    const result = await scheduler.delegate({
      agentName: 'worker',
      prompt: 'x'.repeat(200_000),
      parentSessionId: 'parent',
      parentToolPool: [],
      parentToolContext: { cwd: '/tmp', sessionId: 'parent' },
    });
    expect(result.summary).toBe('done');
    expect(result.estimatedCostUsd).toBeCloseTo(0.000011, 10);
    expect(requests.at(-1)?.modelMetadata?.contextWindow).toBe(contextWindow);
    expect(requests.at(-1)?.maxTokens).toBe(2000);
  }
  expect(calls).toEqual([
    ['openrouter', 'vendor/child'],
    ['openrouter', 'vendor/child'],
  ]);
  record.contextWindow = 1;
  expect(requests[0]?.modelMetadata?.contextWindow).toBe(8_000_000);
});
