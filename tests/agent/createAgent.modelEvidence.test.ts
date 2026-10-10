import { expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

function evidence(model: string) {
  const record = findModel(fallbackModelCatalog('openai-api'), model);
  record.metadata.stale = false;
  record.contextWindow = 100_000;
  record.maxOutputTokens = 2_048;
  return record;
}
function recordingProvider(name = 'openai') {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name,
    async *stream(request) {
      requests.push(request);
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' as const };
      return message;
    },
  };
  return { provider, requests };
}
async function finish(run: ReturnType<ReturnType<typeof createAgent>['run']>) {
  for (;;) {
    const step = await run.next();
    if (step.done) return step.value;
  }
}

for (const perTurnEvidence of [false, true]) {
  test(`model evidence freezes before asynchronous host conduct (${perTurnEvidence ? 'per-turn' : 'standing'})`, async () => {
    const metadata = evidence('first');
    const { provider, requests } = recordingProvider();
    const agent = createAgent({
      provider,
      model: 'first',
      maxTokens: 1_024,
      ...(perTurnEvidence ? {} : { modelMetadata: metadata }),
      conduct: {
        async personaSegments() {
          await Promise.resolve();
          metadata.id = 'other';
          metadata.contextWindow = 64;
          metadata.maxOutputTokens = 1;
          return [];
        },
      },
    });
    const result = await finish(
      agent.run('hello', perTurnEvidence ? { modelMetadata: metadata } : {}),
    );
    expect(result.terminal.reason).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.modelMetadata).toMatchObject({
      id: 'first',
      contextWindow: 100_000,
      maxOutputTokens: 2_048,
    });
    expect(requests[0]?.maxTokens).toBe(1_024);
  });
}

test('reusable agents do not inherit standing metadata for another model or provider', async () => {
  const { provider, requests } = recordingProvider();
  const other = recordingProvider('custom-provider');
  const agent = createAgent({
    provider,
    model: 'first',
    maxTokens: 1_024,
    modelMetadata: evidence('first'),
  });
  expect((await finish(agent.run('hello', { model: 'second' }))).terminal.reason).toBe('completed');
  expect(requests[0]?.model).toBe('second');
  expect(requests[0]?.modelMetadata).toBeUndefined();
  expect((await finish(agent.run('hello', { provider: other.provider }))).terminal.reason).toBe(
    'completed',
  );
  expect(other.requests[0]?.modelMetadata).toBeUndefined();
  await finish(agent.run('hello', { model: 'first' }));
  expect(requests[1]?.modelMetadata?.id).toBe('first');
});

test('explicit replacement evidence wins and mismatched explicit evidence remains rejected', async () => {
  const { provider, requests } = recordingProvider();
  const agent = createAgent({
    provider,
    model: 'first',
    maxTokens: 1_024,
    modelMetadata: evidence('first'),
  });
  const replacement = evidence('second');
  replacement.maxOutputTokens = 512;
  expect(
    (await finish(agent.run('hello', { model: 'second', modelMetadata: replacement }))).terminal
      .reason,
  ).toBe('completed');
  expect(requests[0]?.modelMetadata?.id).toBe('second');
  expect(requests[0]?.maxTokens).toBe(512);
  expect(
    (await finish(agent.run('hello', { model: 'third', modelMetadata: replacement }))).terminal
      .reason,
  ).toBe('error');
  expect(requests).toHaveLength(1);
});
