import { expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message, QueryParams } from '@yevgetman/sov-sdk/core/types';
import { requestInputTokenEstimate } from '@yevgetman/sov-sdk/providers/modelLimits';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import {
  InMemorySkillContinuityStore,
  createSkillContinuity,
} from '@yevgetman/sov-sdk/skills/continuity';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';

const steps = 'CHECK_ARTIFACT then VERIFY_SIGNATURE then RECORD_PUBLICATION.';
const contextWindow = 32_768;
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Continue the workflow.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ],
  },
];
const metadata: ModelRecord = {
  id: 'vision',
  displayName: 'Vision fixture',
  provider: 'fixture',
  routeId: 'fixture',
  auth: 'custom',
  capabilities: {
    textOutput: 'supported',
    tools: 'supported',
    images: 'supported',
    reasoning: 'unsupported',
  },
  contextWindow,
  maxOutputTokens: 128,
  availability: 'unknown',
  metadata: { source: 'fixture', stale: false },
};

async function fixture(includeCatalog = false) {
  const skill = loadSkillText(
    `---\nname: release\ndescription: Release fixture\nwhenToUse: When asked to publish a verified release\n---\n${steps}`,
    { source: 'bundle', trustTier: 'builtin', path: '/virtual/release.md' },
  );
  const registry = { skills: [skill], byName: new Map([[skill.name, skill]]) };
  const runtime = createSkillRuntime({
    load: async () => ({ registry }),
    initial: { registry },
    resolveSkill: async () => skill,
  });
  const scope = { profile: 'fixture', owner: 'owner', session: 'session' };
  const continuity = createSkillContinuity({ scope, store: new InMemorySkillContinuityStore() });
  if (!skill.revision) throw new Error('missing fixture revision');
  await continuity.activated(
    {
      name: skill.name,
      revision: skill.revision,
      source: 'user',
      args: '',
      allowedTools: [],
      allowedResourceRoots: [],
    },
    steps,
    'prior-turn',
  );
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      const answer: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message: answer };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      return answer;
    },
  };
  const context = runtime.bindContext({ cwd: '/', sessionId: scope.session });
  const tools = includeCatalog ? [SkillsListTool as unknown as Tool<unknown, unknown>] : [];
  async function run(retain: boolean, counter?: QueryParams['inputTokenCounter']) {
    const loop = query({
      provider,
      model: 'vision',
      modelMetadata: metadata,
      messages,
      systemPrompt: [{ text: 'Standing host guidance.', cacheable: true }],
      tools,
      maxTokens: 128,
      toolContext: { ...context, ...(retain ? { skillContinuity: continuity } : {}) },
      ...(counter ? { inputTokenCounter: counter } : {}),
    });
    for (;;) {
      const next = await loop.next();
      if (next.done) return next.value;
    }
  }
  return { run, requests, continuity, runtime };
}

function imageCounter(imageTokens: number): NonNullable<QueryParams['inputTokenCounter']> {
  return (request) => {
    const base = requestInputTokenEstimate(request.messages, request.system, request.tools);
    return base.tokens + base.uncountedImages * imageTokens;
  };
}

test('image-aware reservations drop optional continuity guidance before it blocks a valid provider request', async () => {
  const f = await fixture();
  const counter = imageCounter(32_000);
  expect((await f.run(false, counter)).reason).toBe('completed');
  expect(f.requests).toHaveLength(1);
  const control = f.requests[0];
  if (!control) throw new Error('missing control provider request');
  expect(counter(control) + 128).toBeLessThanOrEqual(contextWindow);
  expect((await f.run(true, counter)).reason).toBe('completed');
  expect(f.requests).toHaveLength(2);
  const admitted = f.requests[1];
  if (!admitted) throw new Error('missing continuity provider request');
  expect(JSON.stringify(admitted.messages)).not.toContain(steps);
  expect(counter(admitted) + 128).toBeLessThanOrEqual(contextWindow);
  expect(f.continuity.diagnostics().some((event) => event.code === 'budget-dropped')).toBe(true);
  expect((await f.continuity.exportRecords())[0]?.guidance).toBe(steps);
  f.runtime.dispose();
});

test('headroom restores guidance using the current catalog, standing prompt and actual tool schemas', async () => {
  const f = await fixture(true);
  const counter = imageCounter(2_000);
  const accounted: ProviderRequest[] = [];
  expect(
    (
      await f.run(true, (request) => {
        accounted.push(request);
        expect(request.model).toBe('vision');
        expect(request.modelMetadata?.contextWindow).toBe(metadata.contextWindow);
        expect(request.maxTokens).toBe(128);
        expect(request.system[0]?.text).toBe('Standing host guidance.');
        expect(request.tools?.map((tool) => tool.name)).toEqual(['skills_list']);
        return counter(request);
      })
    ).reason,
  ).toBe('completed');
  expect(f.requests).toHaveLength(1);
  expect(JSON.stringify(f.requests[0]?.messages)).toContain(steps);
  expect(JSON.stringify(f.requests[0]?.system)).not.toContain(steps);
  expect(
    accounted.some(
      (request) =>
        request.system.some((segment) => segment.kind === 'skill-catalog') &&
        !JSON.stringify(request.messages).includes(steps),
    ),
  ).toBe(true);
  expect(f.continuity.diagnostics().some((event) => event.code === 'retained')).toBe(true);
  f.runtime.dispose();
});

test('continuity retains the no-counter fallback when standing text has room', async () => {
  const f = await fixture();
  expect((await f.run(true)).reason).toBe('completed');
  expect(f.requests).toHaveLength(1);
  expect(JSON.stringify(f.requests[0]?.messages)).toContain(steps);
  f.runtime.dispose();
});

test('invalid or failing guidance counters stop provider work after valid catalog accounting', async () => {
  const counters = [
    () => Number.NaN,
    () => -1,
    () => {
      throw new Error('counter failed');
    },
  ];
  for (const counter of counters) {
    const f = await fixture();
    let calls = 0;
    expect(
      (
        await f.run(true, (request) => {
          calls++;
          return calls === 1 ? imageCounter(2_000)(request) : counter();
        })
      ).reason,
    ).toBe('error');
    expect(calls).toBe(2);
    expect(f.requests).toHaveLength(0);
    expect((await f.continuity.exportRecords())[0]?.guidance).toBe(steps);
    expect(f.continuity.diagnostics().some((event) => event.code === 'retained')).toBe(false);
    f.runtime.dispose();
  }
});
