import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { type SkillRuntimeEvent, createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { SkillManageTool } from '@yevgetman/sov-sdk/tools/SkillManageTool';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { z } from 'zod';

const markdown = (name: string, body = 'Follow {{args}}.', metadata = '') =>
  `---\nname: ${name}\ndescription: ${name} instructions\nwhenToUse: Use when the caller asks to run the ${name} workflow.\n${metadata}---\n${body}`;

const context = () => ({ cwd: '/no-such-memory-skill-root', sessionId: 'runtime-fixture' });

function providerWithCalls(calls: { name: string; input: unknown }[]): {
  provider: LLMProvider;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'skill-runtime-fixture',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const call = calls.shift();
      const message: AssistantMessage = call
        ? {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `call-${requests.length}`, ...call }],
          }
        : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: call ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  return { provider, requests };
}

describe('optional composed skill runtime', () => {
  test('independent recreation of the same tree still emits a new committed event', async () => {
    const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
    const notifications: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'mutation') notifications.push(event.event.action);
    });
    const create = { action: 'create', name: 'repeat', content: markdown('repeat') } as const;
    const first = await runtime.mutate(create);
    await runtime.mutate({
      action: 'delete',
      name: 'repeat',
      expectedRevision: first.entry?.revision ?? '',
    });
    const second = await runtime.mutate(create);
    expect(second.entry?.revision).toBe(first.entry?.revision);
    expect(notifications).toEqual(['create', 'delete', 'create']);
    runtime.dispose();
  });
  test.each([false, true])(
    'a host can forward mutation events without recursion (async: %s)',
    async (deferred) => {
      const store = new InMemorySkillStore();
      const runtime = createSkillRuntime({ store });
      await runtime.discover();
      const notifications: string[] = [];
      const forwarded = new Set<string>();
      const publications: Promise<void>[] = [];
      runtime.subscribe((event) => {
        if (event.type !== 'mutation') return;
        notifications.push(event.event.name);
        if (!forwarded.has(event.event.name)) {
          forwarded.add(event.event.name);
          publications.push(
            deferred
              ? Promise.resolve().then(() => runtime.onMutation({ ...event.event }))
              : runtime.onMutation({ ...event.event }),
          );
        }
      });
      await store.mutate({ action: 'create', name: 'external', content: markdown('external') });
      await Promise.all(publications);
      await runtime.mutate({ action: 'create', name: 'owned', content: markdown('owned') });
      await Promise.all(publications);
      expect(notifications).toEqual(['external', 'owned']);
      expect(runtime.snapshot().registry.byName.has('external')).toBe(true);
      expect(runtime.snapshot().registry.byName.has('owned')).toBe(true);
      runtime.dispose();
    },
  );
  test('rejected async observers cannot terminate a public Node host after catalog or store publication', () => {
    const script = `
      import { createSkillRuntime, InMemorySkillStore } from '@yevgetman/sov-sdk';
      const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
      const events = [];
      runtime.subscribe(async (event) => {
        events.push(event.type);
        await Promise.resolve();
        throw new Error('observer rejected');
      });
      await runtime.discover();
      const committed = await runtime.mutate({
        action: 'create', name: 'safe',
        content: '---\\nname: safe\\ndescription: Safe workflow\\n---\\nKeep working.',
      });
      try { await runtime.inspect('missing'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
      if (!committed.entry || !runtime.snapshot().registry.byName.has('safe'))
        throw new Error('publication lost');
      runtime.dispose();
      console.log(JSON.stringify(events));
    `;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['refreshed', 'mutation', 'refreshed', 'error']);
  });
  test('injected script resources are guarded and oversized bodies/resources fail before activation effects', async () => {
    const store = new InMemorySkillStore();
    await store.mutate({ action: 'create', name: 'injected', content: markdown('injected') });
    let resource: Uint8Array | undefined;
    let oversizedBody = false;
    const injected = {
      list: store.list.bind(store),
      mutate: store.mutate.bind(store),
      subscribe: store.subscribe.bind(store),
      async read(name: string) {
        const entry = await store.read(name);
        if (!entry) return undefined;
        return {
          ...entry,
          ...(oversizedBody ? { content: 'x'.repeat(1024 * 1024 + 1) } : {}),
          files: new Map([
            ...entry.files,
            ...(resource ? [['helper.sh', { data: resource }] as const] : []),
          ]),
        };
      },
    };
    const runtime = createSkillRuntime({
      store: injected,
      storeClassification: { source: 'user', trustTier: 'community' },
    });
    await runtime.discover();
    let approvals = 0;
    const state = createSkillActivationState({
      tools: [SkillTool],
      canUseTool: async () => {
        approvals++;
        return { behavior: 'allow' };
      },
    });
    const activate = () =>
      runtime.activate('injected', { source: 'user', toolContext: context(), state });
    resource = new TextEncoder().encode('cat ~/.ssh/id_rsa');
    await expect(activate()).rejects.toThrow('BLOCKED');
    resource = new Uint8Array(1024 * 1024 + 1);
    await expect(activate()).rejects.toThrow('bounded file limit');
    resource = undefined;
    oversizedBody = true;
    await expect(activate()).rejects.toThrow('bounded file limit');
    expect(approvals).toBe(0);
    expect(state.activations).toHaveLength(0);
    runtime.dispose();
  });
  test('a membership change during the final discovery page cannot publish an incomplete catalog', async () => {
    const store = new InMemorySkillStore();
    await store.mutate({ action: 'create', name: 'first', content: markdown('first', 'original') });
    await store.mutate({
      action: 'create',
      name: 'second',
      content: markdown('second', 'original'),
    });
    let interleave = false;
    const injected = {
      list: store.list.bind(store),
      mutate: store.mutate.bind(store),
      subscribe: store.subscribe.bind(store),
      async read(name: string) {
        const entry = await store.read(name);
        if (interleave && name === 'first') {
          interleave = false;
          await store.mutate({
            action: 'create',
            name: 'third',
            content: markdown('third', 'changed'),
          });
        }
        return entry;
      },
    };
    const runtime = createSkillRuntime({ store: injected });
    await runtime.discover();
    interleave = true;
    await expect(runtime.refresh()).rejects.toThrow('changed during discovery');
    expect(runtime.snapshot().generation).toBe(1);
    expect(runtime.snapshot().registry.byName.has('third')).toBe(false);
    await runtime.refresh();
    expect(runtime.snapshot().registry.byName.get('third')?.body).toBe('changed');
    runtime.dispose();
  });
  test('profile binding removes an old store and readonly catalogs refuse ambient write fallback', async () => {
    const writable = createSkillRuntime({ store: new InMemorySkillStore() });
    await writable.discover();
    const readonly = createSkillRuntime({
      load: async () => ({ registry: { skills: [], byName: new Map() } }),
    });
    await readonly.discover();
    const first = writable.bindContext({ ...context(), harnessHome: '/missing-other-profile' });
    const second = readonly.bindContext(first);
    expect(second.skillStore).toBeUndefined();
    const result = await SkillManageTool.call(
      { action: 'create', name: 'blocked', body: 'Should not be stored' },
      second,
    );
    expect(result.data.ok).toBe(false);
    await second.onSkillMutation?.({ action: 'create', name: 'external' });
    expect(writable.snapshot().generation).toBe(1);
    expect(readonly.snapshot().generation).toBe(2);
    writable.dispose();
    readonly.dispose();
  });

  test('rebinding a composed context refreshes only once after tool mutation', async () => {
    const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
    await runtime.discover();
    const bound = runtime.bindContext(runtime.bindContext(context()));
    const result = await SkillManageTool.call(
      {
        action: 'create',
        name: 'newEntry',
        body: 'Follow the task',
        frontmatter: {
          description: 'New entry',
          whenToUse: 'Use when asked to run the new entry workflow.',
        },
      },
      bound,
    );
    expect(result.data.ok).toBe(true);
    expect(runtime.snapshot().generation).toBe(2);
    runtime.dispose();
  });
  test('a native child inherits the memory profile and cannot widen its parent tool scope', async () => {
    const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
    await runtime.mutate({
      action: 'create',
      name: 'childSkill',
      content: markdown('childSkill', 'Child instructions', 'allowedTools: [Read, SkillTool]\n'),
    });
    let writes = 0;
    const read = buildTool({
      name: 'Read',
      description: () => 'fixture read',
      inputSchema: z.object({}),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => ({ data: 'read' }),
    });
    const write = buildTool({
      name: 'Write',
      description: () => 'fixture write',
      inputSchema: z.object({}),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        writes++;
        return { data: 'write' };
      },
    });
    const tools = [read, write, SkillTool];
    const parent = runtime.bindContext(context());
    const state = createSkillActivationState({
      tools,
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    parent.skillActivation = state;
    await runtime.activate('childSkill', { source: 'user', toolContext: parent, state });
    const child: AgentDefinition = {
      name: 'child',
      description: 'fixture',
      systemPrompt: 'fixture',
      allowedTools: ['Read', 'Write', 'SkillTool'],
      maxTurns: 4,
      readOnly: false,
      supportsMissionState: false,
      inheritParentTools: true,
      allowedSubagents: [],
      path: 'virtual:/child',
      realpath: 'virtual:/child',
      dir: 'virtual:/',
      source: 'bundle',
      trustTier: 'builtin',
    };
    const fixture = providerWithCalls([
      { name: 'SkillTool', input: { skill: 'childSkill' } },
      { name: 'Write', input: {} },
    ]);
    const scheduler = new SubagentScheduler({
      agents: { agents: [child], byName: new Map([[child.name, child]]) },
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      resolveProvider: () => ({
        transport: Object.assign(new MockProvider(), { stream: fixture.provider.stream }),
        client: fixture.provider,
        baseUrl: 'fixture://',
        model: 'fixture',
        contextLength: 32_000,
        authType: 'none',
        metadata: { provider: 'fixture' },
      }),
      createChildSession: () => 'memory-child',
      defaultProvider: 'fixture',
      defaultModel: 'fixture',
      maxTokens: 100,
    });
    const result = await scheduler.delegate({
      agentName: 'child',
      prompt: 'work',
      parentSessionId: parent.sessionId,
      parentToolPool: state.tools,
      parentToolContext: parent,
      canUseTool: state.canUseTool,
    });
    expect(result.terminal.reason).toBe('completed');
    expect(writes).toBe(0);
    expect(
      fixture.requests.every((request) => !request.tools?.some((tool) => tool.name === 'Write')),
    ).toBe(true);
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain('Child instructions');
    runtime.dispose();
  });
  test('store-only catalogs, resource inspection and model activation do not resolve virtual paths', async () => {
    const store = new InMemorySkillStore();
    await store.mutate({
      action: 'create',
      name: 'portable',
      content: markdown('portable'),
      files: new Map([
        ['references/note.md', { data: new TextEncoder().encode('Raw !`never execute`') }],
      ]),
    });
    const runtime = createSkillRuntime({ store });
    await runtime.discover();
    expect(runtime.snapshot().registry.byName.has('portable')).toBe(true);
    const bound = runtime.bindContext(context());
    bound.skillActivation = createSkillActivationState({ tools: [SkillTool] });
    const viewed = await SkillsViewTool.call(
      { name: 'portable', path: 'references/note.md' },
      bound,
    );
    expect(viewed.data.content).toBe('Raw !`never execute`');
    await expect(runtime.inspect('portable', '../escape')).rejects.toThrow('unsafe');
    const activated = await SkillTool.call({ skill: 'portable', args: 'the request' }, bound);
    expect(activated.data.prompt).toBe('Follow the request.');
    expect(activated.data.activation.allowedResourceRoots).toEqual([]);
    expect(activated.data.activation.revision).toMatch(/^[a-f0-9]{64}$/);
    runtime.dispose();
  });

  test('two profile runtimes retain separate stores and config opt-in reaches actual SkillTool calls', async () => {
    const first = createSkillRuntime({ store: new InMemorySkillStore() });
    const second = createSkillRuntime({ store: new InMemorySkillStore() });
    await first.mutate({
      action: 'create',
      name: 'one',
      content: markdown('one', 'Profile one {{args}}'),
    });
    await second.mutate({ action: 'create', name: 'two', content: markdown('two') });
    expect(first.snapshot().registry.skills.map((skill) => skill.name)).toEqual(['one']);
    expect(second.snapshot().registry.skills.map((skill) => skill.name)).toEqual(['two']);
    const fixture = providerWithCalls([
      { name: 'SkillTool', input: { skill: 'one', args: 'works' } },
    ]);
    const agent = createAgent({
      provider: fixture.provider,
      model: 'fixture',
      cwd: context().cwd,
      tools: [SkillTool],
      skillRuntime: first,
    });
    const run = agent.run('Activate one');
    let result = await run.next();
    while (!result.done) result = await run.next();
    expect(result.value.terminal.reason).toBe('completed');
    expect(fixture.requests).toHaveLength(2);
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain('Profile one works');
    expect(JSON.stringify(fixture.requests[1]?.messages)).not.toContain('Profile two');
    first.dispose();
    second.dispose();
  });

  test('model/manual descriptor rules and headless guard denial share activation', async () => {
    const store = new InMemorySkillStore();
    const runtime = createSkillRuntime({ store });
    await runtime.mutate({
      action: 'create',
      name: 'manual',
      content: markdown('manual', 'Manual only', 'disable-model-invocation: true\n'),
    });
    const bound = runtime.bindContext(context());
    bound.skillActivation = createSkillActivationState({ tools: [SkillTool] });
    await expect(SkillTool.call({ skill: 'manual' }, bound)).rejects.toThrow('model invocation');
    expect(
      (
        await runtime.activate('manual', {
          source: 'user',
          toolContext: bound,
          state: bound.skillActivation,
        })
      ).prompt,
    ).toBe('Manual only');
    const guarded = loadSkillText(markdown('guarded'), {
      source: 'agent-created',
      trustTier: 'agent-created',
      path: 'virtual:/guarded/SKILL.md',
    });
    guarded.guard = { action: 'ask', findings: [] };
    const guardRuntime = createSkillRuntime({
      load: async () => ({
        registry: { skills: [guarded], byName: new Map([[guarded.name, guarded]]) },
      }),
      resolveSkill: async (skill) => skill,
      allowedResourceRoots: async () => [],
    });
    await guardRuntime.discover();
    await expect(
      guardRuntime.activate('guarded', {
        source: 'user',
        toolContext: context(),
        state: createSkillActivationState({ tools: [SkillTool] }),
      }),
    ).rejects.toThrow('host guard approval');
    guardRuntime.dispose();
    runtime.dispose();
  });

  test('memory inline shell uses an explicit host cwd and cannot bypass the Bash permission gate', async () => {
    const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
    await runtime.mutate({
      action: 'create',
      name: 'inline',
      content: markdown('inline', 'Result !`printf fixture`'),
    });
    const seen: string[] = [];
    const bash = buildTool({
      name: 'Bash',
      description: () => 'fixture',
      inputSchema: z.object({ command: z.string(), timeout_ms: z.number() }),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async (_input, ctx) => {
        seen.push(ctx.cwd);
        return { data: { stdout: 'fixture', exit_code: 0 } };
      },
    });
    const bound = runtime.bindContext(context());
    const denied = createSkillActivationState({
      tools: [bash],
      canUseTool: async () => ({ behavior: 'deny', reason: 'host refused' }),
    });
    await expect(
      runtime.activate('inline', { source: 'user', toolContext: bound, state: denied }),
    ).rejects.toThrow('inline shell failed');
    expect(seen).toEqual([]);
    const approved = createSkillActivationState({
      tools: [bash],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const activated = await runtime.activate('inline', {
      source: 'user',
      toolContext: bound,
      state: approved,
    });
    expect(activated.prompt).toBe('Result fixture');
    expect(seen).toEqual([context().cwd]);
    runtime.dispose();
  });

  test('refresh errors retain the published generation and observers receive committed mutation events', async () => {
    const store = new InMemorySkillStore();
    let fail = false;
    const skill = loadSkillText(markdown('existing'), {
      source: 'user',
      trustTier: 'trusted',
      path: 'virtual:/existing/SKILL.md',
    });
    const runtime = createSkillRuntime({
      store,
      load: async () => {
        if (fail) throw new Error('host load failed');
        return { registry: { skills: [skill], byName: new Map([[skill.name, skill]]) } };
      },
      resolveSkill: async (item) => item,
      allowedResourceRoots: async () => [],
    });
    const events: SkillRuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.discover();
    fail = true;
    const result = await runtime.mutate({
      action: 'create',
      name: 'committed',
      content: markdown('committed'),
    });
    expect(result.event.action).toBe('create');
    expect(await store.read('committed')).toBeDefined();
    expect(runtime.snapshot().generation).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['refreshed', 'mutation', 'error']);
    runtime.dispose();
    await expect(runtime.refresh()).rejects.toThrow('disposed');
  });

  test('store discovery follows all pages and rejects a stalled injected cursor', async () => {
    const store = new InMemorySkillStore();
    for (let index = 0; index < 105; index++) {
      const name = `entry-${index}`;
      await store.mutate({ action: 'create', name, content: markdown(name) });
    }
    const runtime = createSkillRuntime({ store });
    expect((await runtime.discover()).registry.skills).toHaveLength(105);
    runtime.dispose();
    const stalled = createSkillRuntime({
      store: {
        read: (name) => store.read(name),
        mutate: (change) => store.mutate(change),
        subscribe: (fn) => store.subscribe(fn),
        list: async () => ({ names: [], generation: 'stable', truncated: true }),
      },
    });
    await expect(stalled.discover()).rejects.toThrow('stalled');
    stalled.dispose();
  });
});
