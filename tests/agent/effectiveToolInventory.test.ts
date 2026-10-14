import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, SystemSegment } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { getSkillRegistry } from '@yevgetman/sov-sdk/skills/registry';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { CapabilityProfileRegistry } from '@yevgetman/sov-sdk/tool/capabilityProfiles';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { buildToolSearchTool } from '@yevgetman/sov-sdk/tools/ToolSearchTool';
import { z } from 'zod';
import { modelSystemPrompt } from '../../src/server/modelMetadata.js';
import type { Runtime } from '../../src/server/runtime.js';
import { composeTurn } from '../../src/server/turnComposition.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const boot: SystemSegment[] = [
  { text: 'standing directives', cacheable: true },
  { text: '<available-tools>\n- Forbidden: stale boot help\n</available-tools>', cacheable: true },
];
const call = (name: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: name, name, input: {} }],
});
const final: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
function recorder(replies: AssistantMessage[]) {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      requests.push(structuredClone(request));
      const message = replies.shift() ?? final;
      yield { type: 'assistant_message' as const, message };
      yield {
        type: 'message_stop' as const,
        stop_reason: message.content.some((b) => b.type === 'tool_use')
          ? ('tool_use' as const)
          : ('end_turn' as const),
      };
      return message;
    },
  };
  return { provider, requests };
}
function tool(name: string, effect: (ctx: ToolContext) => void = () => {}, deferred = false) {
  return buildTool<unknown, unknown>({
    name,
    description: () => `help for ${name}`,
    inputSchema: z.object({}),
    ...(deferred
      ? {
          shouldDefer: true,
          inputJSONSchema: { type: 'object', properties: { value: { type: 'string' } } },
        }
      : {}),
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    call: async (_, ctx) => {
      effect(ctx);
      return { data: 'ok' };
    },
  });
}
function inventory(request: ProviderRequest) {
  const segment = request.system.find((s) => s.text.startsWith('<available-tools>\n'));
  return (
    segment?.text
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).split(':')[0]) ?? []
  );
}
function compare(request: ProviderRequest | undefined, names: string[]) {
  if (!request) throw new Error('provider request missing');
  expect(inventory(request)).toEqual(names);
  expect(request.tools?.map((t) => t.name) ?? []).toEqual(names);
  expect(request.system[0]).toEqual(boot[0]);
  expect(request.system.map((s) => s.text).join('\n')).not.toContain('Forbidden');
}

const names = ['Bash', 'FileRead', 'WebSearch', 'WebFetch', 'memory', 'skills_list', 'skill_view'];
const profiles = new CapabilityProfileRegistry([{ name: 'custom', tools: ['WebFetch'] }]);
for (const evidence of ['current', 'stale', 'unknown'] as const) {
  for (const [toolset, expected] of [
    ['chat', []],
    ['web', ['WebSearch', 'WebFetch']],
    ['ops', ['memory', 'skills_list', 'skill_view']],
    ['coding', names],
    ['custom', ['WebFetch']],
  ] as const) {
    test(`${evidence} metadata: ${toolset} prompt/schemas/execution/child inheritance agree`, async () => {
      let forbiddenEffects = 0;
      let effectiveContext: ToolContext | undefined;
      const pool = names.map((name) =>
        tool(name, (ctx) => {
          effectiveContext = { ...ctx };
        }),
      );
      pool.push(
        tool('Forbidden', () => {
          forbiddenEffects++;
        }),
      );
      // coding retains the boot pool, so do not supply Forbidden there.
      const supplied = toolset === 'coding' ? pool.slice(0, -1) : pool;
      const record = findModel(fallbackModelCatalog('openrouter-api'), 'vendor/future');
      if (evidence !== 'unknown') record.contextWindow = 100_000;
      record.metadata.stale = evidence === 'stale';
      const { provider, requests } = recorder([
        call(expected[0] ?? 'Bash'),
        call('Forbidden'),
        final,
      ]);
      const agent = createAgent({
        provider,
        model: 'fixture',
        tools: supplied,
        maxTurns: 4,
        capabilityProfiles: profiles,
        toolset,
        systemPrompt: modelSystemPrompt(boot, supplied, record),
      });
      for await (const _ of agent.run('probe', {
        toolContext: { cwd: '/tmp', sessionId: 'fixture', parentToolPool: pool },
      })) {
      }
      compare(requests[0], [...expected]);
      if (expected.length) {
        expect(effectiveContext?.activeToolNames).toEqual([...expected]);
        expect(effectiveContext?.parentToolPool?.map((t) => t.name)).toEqual([...expected]);
      }
      expect(forbiddenEffects).toBe(0);
      expect(boot[1]?.text).toContain('Forbidden');
    });
  }
}

test('deferred tools disappear without ToolSearch and discovery uses effective policy', async () => {
  const a = tool('mcp__allowed', () => {}, true);
  const b = tool('mcp__forbidden', () => {}, true);
  const search = buildToolSearchTool(() => [a, b]);
  const profiles = new CapabilityProfileRegistry([
    { name: 'without-search', tools: [a.name] },
    { name: 'with-search', tools: ['ToolSearch', a.name] },
  ]);
  for (const profile of ['without-search', 'with-search']) {
    const { provider, requests } = recorder([final]);
    const agent = createAgent({
      provider,
      model: 'fixture',
      tools: [search, a, b],
      systemPrompt: boot,
      capabilityProfiles: profiles,
      toolset: profile,
    });
    for await (const _ of agent.run('probe')) {
    }
    compare(requests[0], profile === 'without-search' ? [] : ['ToolSearch', a.name]);
  }
  const result = await search.call(
    { query: '' },
    { cwd: '/tmp', sessionId: 'fixture', parentToolPool: [search, a] },
  );
  expect(result.data.matched.map((t) => t.name)).toEqual([a.name]);
  expect(result.data.matched[0]?.inputSchema).toEqual(a.inputJSONSchema);
});

test('inherited and mid-turn skill allow-lists refresh prompt, discovery and visible skills', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'inventory-'));
  dirs.push(cwd);
  const dir = join(cwd, '.harness', 'skills', 'narrow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: narrow\ndescription: Narrow\nallowedTools: [ToolSearch, mcp__allowed, skills_list]\n---\nUse permitted tools.',
  );
  const invisible = join(cwd, '.harness', 'skills', 'shell');
  mkdirSync(invisible, { recursive: true });
  writeFileSync(
    join(invisible, 'SKILL.md'),
    '---\nname: shell\ndescription: Shell only\nmetadata:\n  harness:\n    requires_tools: [Bash]\n---\nUse shell.',
  );
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty') });
  const narrow = skills.byName.get('narrow');
  if (!narrow) throw new Error('fixture skill missing');
  const a = tool('mcp__allowed', () => {}, true);
  const b = tool('mcp__forbidden', () => {}, true);
  const search = buildToolSearchTool(() => [a, b]);
  let deniedEffects = 0;
  let visible: string[] = [];
  const list = tool('skills_list', (ctx) => {
    visible = getSkillRegistry(ctx).skills.map((s) => s.name);
  });
  const activate = buildTool<unknown, unknown>({
    name: 'Narrow',
    description: () => 'activate',
    inputSchema: z.object({}),
    call: async (_, ctx) => {
      if (!ctx.skillActivation) throw new Error('activation missing');
      await activateSkill(narrow, { source: 'user', toolContext: ctx, state: ctx.skillActivation });
      return { data: 'activated' };
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool pool
  const pool: Tool<any, any>[] = [
    activate,
    search,
    a,
    b,
    list,
    tool('Bash', () => {
      deniedEffects++;
    }),
  ];
  const { provider, requests } = recorder([
    call('Narrow'),
    call('skills_list'),
    call('Bash'),
    final,
  ]);
  for await (const _ of query({
    provider,
    model: 'fixture',
    maxTokens: 1000,
    systemPrompt: boot,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
    tools: pool,
    toolContext: { cwd, sessionId: 'fixture', skills },
    maxTurns: 5,
  })) {
  }
  compare(requests[1], ['ToolSearch', a.name, 'skills_list']);
  expect(visible).not.toContain('shell');
  expect(deniedEffects).toBe(0);
  const inherited = createSkillActivationState({ tools: pool });
  const context: ToolContext = { cwd, sessionId: 'fixture', skills, skillActivation: inherited };
  await activateSkill(narrow, { source: 'user', toolContext: context, state: inherited });
  const lookup = await search.call({ query: '' }, context);
  expect(lookup.data.matched.map((t) => t.name)).toEqual([a.name]);
  const child = recorder([final]);
  for await (const _ of query({
    provider: child.provider,
    model: 'fixture',
    maxTokens: 1000,
    systemPrompt: boot,
    messages: [],
    tools: pool,
    toolContext: context,
  })) {
  }
  compare(child.requests[0], ['ToolSearch', a.name, 'skills_list']);
});

test('a reused host context retains identity and its original inventory after each toolset', async () => {
  const context: ToolContext = { cwd: '/tmp', sessionId: 'fixture' };
  const pool = ['WebFetch', 'memory'].map((name) =>
    tool(name, (ctx) => {
      expect(ctx).toBe(context);
      expect(ctx.activeToolNames).toEqual([name]);
      expect(ctx.parentToolPool?.map((t) => t.name)).toEqual([name]);
    }),
  );
  for (const [toolset, name] of [
    ['web', 'WebFetch'],
    ['ops', 'memory'],
  ] as const) {
    const { provider } = recorder([call(name), final]);
    for await (const _ of createAgent({ provider, model: 'fixture', tools: pool, toolset }).run(
      'probe',
      { toolContext: context },
    )) {
    }
    expect(context.activeToolNames).toBeUndefined();
    expect(context.parentToolPool).toBeUndefined();
  }
});

test('a skill that removes ToolSearch cannot leave a deferred call runnable in the same batch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'inventory-deferred-'));
  dirs.push(cwd);
  const dir = join(cwd, '.harness', 'skills', 'narrow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: narrow\ndescription: Narrow\nallowedTools: [mcp__allowed]\n---\nUse permitted tools.',
  );
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty') });
  const narrow = skills.byName.get('narrow');
  if (!narrow) throw new Error('fixture skill missing');
  let effects = 0;
  const deferred = tool(
    'mcp__allowed',
    () => {
      effects++;
    },
    true,
  );
  const search = buildToolSearchTool(() => [deferred]);
  const activate = buildTool<unknown, unknown>({
    name: 'Narrow',
    description: () => 'activate',
    inputSchema: z.object({}),
    call: async (_, ctx) => {
      if (!ctx.skillActivation) throw new Error('activation missing');
      await activateSkill(narrow, { source: 'user', toolContext: ctx, state: ctx.skillActivation });
      return { data: 'activated' };
    },
  });
  const batch: AssistantMessage = {
    role: 'assistant',
    content: [...call('Narrow').content, ...call(deferred.name).content],
  };
  const { provider, requests } = recorder([batch, final]);
  for await (const _ of createAgent({
    provider,
    model: 'fixture',
    tools: [activate, search, deferred],
    systemPrompt: boot,
  }).run('probe', { toolContext: { cwd, sessionId: 'fixture', skills } })) {
  }
  expect(effects).toBe(0);
  compare(requests[1], []);
});

test('SOV composition exposes the same effective inventory and gate before SDK execution', async () => {
  const deferred = tool('mcp__allowed', () => {}, true);
  const search = buildToolSearchTool(() => [deferred]);
  const { provider, requests } = recorder([final]);
  const pool = [tool('Bash'), tool('WebFetch'), search, deferred];
  const runtime = {
    resolvedProvider: { transport: provider },
    model: 'fixture',
    maxTokens: 1000,
    cwd: '/tmp',
    systemSegments: boot,
    toolPool: pool,
  } as unknown as Runtime;
  const opts = {
    runtime,
    persistence: { mode: 'sdk-store' as const, sessionStore: createInMemorySessionStore() },
    canUseTool: async () => ({ behavior: 'allow' as const }),
  };
  const web = composeTurn({ ...opts, toolset: 'web' });
  expect(web.tools.map((t) => t.name)).toEqual(['WebFetch']);
  expect(
    (
      await web.canUseTool(
        pool[0] as Tool<unknown, unknown>,
        {},
        { cwd: '/tmp', sessionId: 'fixture' },
      )
    ).behavior,
  ).toBe('deny');
  for await (const _ of web.agent.run('probe')) {
  }
  compare(requests[0], ['WebFetch']);
  const skill = composeTurn({ ...opts, skillScope: ['mcp__allowed'] });
  expect(skill.tools).toEqual([]);
  expect(
    (await skill.canUseTool(deferred, {}, { cwd: '/tmp', sessionId: 'fixture' })).behavior,
  ).toBe('deny');
});
