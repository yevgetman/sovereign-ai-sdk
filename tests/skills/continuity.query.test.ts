import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message, Terminal } from '@yevgetman/sov-sdk/core/types';
import { AnthropicProvider } from '@yevgetman/sov-sdk/providers/anthropic';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import {
  InMemorySkillContinuityStore,
  createSkillContinuity,
} from '@yevgetman/sov-sdk/skills/continuity';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { z } from 'zod';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const steps = 'CHECK_ARTIFACT then VERIFY_SIGNATURE then RECORD_PUBLICATION.';
async function fixture(lifetime: 'turn' | 'session' = 'session') {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-continuity-'));
  dirs.push(cwd);
  const dir = join(cwd, '.harness/skills/release');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(
    path,
    `---\nname: release\ndescription: Release fixture\nallowedTools: [Read]\n---\n${steps}`,
  );
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty') });
  const store = new InMemorySkillContinuityStore();
  const scope = { profile: 'fixture', owner: 'owner', session: 'session' };
  const continuity = createSkillContinuity({ scope, store, lifetime });
  const ctx: ToolContext = { cwd, sessionId: scope.session, skills, skillContinuity: continuity };
  const tools = ['Read', 'Write'].map((name) =>
    buildTool<unknown, unknown>({
      name,
      description: () => name,
      inputSchema: z.unknown(),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => ({ data: 'ok' }),
    }),
  );
  const state = createSkillActivationState({
    tools,
    canUseTool: async () => ({ behavior: 'allow' }),
  });
  const skill = skills.byName.get('release');
  if (!skill) throw new Error('missing fixture skill');
  const activated = await activateSkill(skill, {
    source: 'user',
    toolContext: ctx,
    state,
  });
  return { cwd, dir, path, skills, ctx, store, scope, continuity, state, tools, activated };
}
function provider(mode: 'complete' | 'error' = 'complete') {
  const requests: ProviderRequest[] = [];
  const p: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      yield { type: 'message_start' };
      if (mode === 'error') throw new Error('private provider error');
      const answer: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message: answer };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      return answer;
    },
  };
  return { p, requests };
}
async function drain(gen: ReturnType<typeof query>) {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
const latest: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Continue the workflow.' }],
};

describe('skill guidance in the real turn loop', () => {
  test('forced compaction and fresh resume retain recorded steps while permissions expire', async () => {
    const f = await fixture();
    const first = provider();
    let reductions = 0;
    const seed: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: f.activated.prompt + ' old '.repeat(3000) }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier progress.' }] },
      latest,
    ];
    const terminal = await drain(
      query({
        provider: first.p,
        model: 'custom',
        messages: seed,
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: { ...f.ctx, skillActivation: f.state },
        contextLimits: { maxHistoryBytes: 500, contextWindowTokens: 32_768 },
        contextManager: {
          reduce: async () => {
            reductions++;
            return { messages: [latest] };
          },
        },
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(reductions).toBe(1);
    expect(JSON.stringify(first.requests[0]?.messages)).toContain(steps);
    expect(JSON.stringify(first.requests[0]?.messages)).not.toContain(' old  old ');
    expect(JSON.stringify(first.requests[0]?.system)).not.toContain('CHECK_ARTIFACT');
    expect(first.requests[0]?.tools?.map((t) => t.name)).toEqual(['Read']);
    const recordedRevision = f.activated.activation.revision;
    writeFileSync(
      f.path,
      '---\nname: release\ndescription: Updated fixture\n---\nREPLACEMENT STEPS',
    );
    const resumed = createSkillContinuity({ scope: f.scope, store: f.store });
    const second = provider();
    await drain(
      query({
        provider: second.p,
        model: 'another-provider-model',
        messages: [latest],
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: { ...f.ctx, skillContinuity: resumed },
      }),
    );
    const guidance = JSON.stringify(second.requests[0]?.messages);
    expect(guidance).toContain(steps);
    expect(guidance).toContain(recordedRevision);
    expect(guidance).not.toContain('REPLACEMENT STEPS');
    expect(second.requests[0]?.tools?.map((t) => t.name)).toEqual(['Read', 'Write']);
    expect(resumed.diagnostics().some((event) => event.code === 'revision-changed')).toBe(true);
    expect(f.ctx.skillActivation).toBeUndefined();
  });
  test('query cancellation, provider failure and turn expiry record safe outcomes', async () => {
    for (const mode of ['cancel', 'error'] as const) {
      const f = await fixture('turn');
      const { p } = provider(mode === 'error' ? 'error' : 'complete');
      const gen = query({
        provider: p,
        model: 'custom',
        messages: [latest],
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: { ...f.ctx, skillActivation: f.state },
      });
      if (mode === 'cancel') {
        await gen.next();
        await gen.return(undefined as unknown as Terminal);
      } else expect((await drain(gen)).reason).toBe('error');
      expect(await f.continuity.exportRecords()).toEqual([]);
      expect(
        f.continuity
          .diagnostics()
          .some((event) => event.code === (mode === 'cancel' ? 'cancelled' : 'failed')),
      ).toBe(true);
      expect(JSON.stringify(f.continuity.diagnostics())).not.toContain('private provider error');
    }
  });
  test('wrong-session continuity fails before provider or activation effects', async () => {
    const f = await fixture();
    const { p, requests } = provider();
    const wrong = { ...f.ctx, sessionId: 'other' };
    expect(
      (
        await drain(
          query({
            provider: p,
            model: 'custom',
            messages: [latest],
            systemPrompt: [],
            tools: f.tools,
            maxTokens: 128,
            toolContext: wrong,
          }),
        )
      ).reason,
    ).toBe('error');
    expect(requests).toHaveLength(0);
    const skill = f.skills.byName.get('release');
    if (!skill) throw new Error('missing fixture skill');
    await expect(
      activateSkill(skill, {
        source: 'user',
        toolContext: wrong,
        state: f.state,
      }),
    ).rejects.toThrow('scope');
  });
  test('a truncated provider response records failed guidance without claiming success', async () => {
    const f = await fixture();
    const p: LLMProvider = {
      name: 'fixture',
      async *stream() {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'truncated-read', name: 'Read', input: {} }],
        };
        yield { type: 'assistant_message', message };
        yield { type: 'message_stop', stop_reason: 'max_tokens' };
        return message;
      },
    };
    const terminal = await drain(
      query({
        provider: p,
        model: 'custom',
        messages: [latest],
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: { ...f.ctx, skillActivation: f.state },
      }),
    );
    expect(terminal.reason).toBe('max_tokens');
    const records = await f.continuity.exportRecords();
    expect(records[0]?.outcome).toBe('failed');
    expect(records[0]?.guidance).toBe(steps);
    expect(f.continuity.diagnostics().some((event) => event.code === 'succeeded')).toBe(false);
    expect(f.continuity.diagnostics().some((event) => event.code === 'failed')).toBe(true);
  });
  test('reference contents survive resume; mid-workflow reference edits refuse replacement', async () => {
    const f = await fixture();
    const reference = join(f.dir, 'steps.md');
    writeFileSync(reference, 'PINNED_REFERENCE');
    await SkillsViewTool.call({ name: 'release', path: 'steps.md' }, f.ctx);
    writeFileSync(reference, 'REPLACEMENT_REFERENCE');
    await expect(SkillsViewTool.call({ name: 'release', path: 'steps.md' }, f.ctx)).rejects.toThrow(
      'reactivate',
    );
    const resumed = createSkillContinuity({ scope: f.scope, store: f.store });
    const { p, requests } = provider();
    await drain(
      query({
        provider: p,
        model: 'custom',
        messages: [latest],
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: { ...f.ctx, skillContinuity: resumed },
      }),
    );
    expect(JSON.stringify(requests[0]?.messages)).toContain('PINNED_REFERENCE');
    expect(JSON.stringify(resumed.diagnostics())).not.toContain(reference);
  });
  test('composed filesystem references reject a canonical link retarget even with identical content', async () => {
    const f = await fixture();
    writeFileSync(join(f.dir, 'one.md'), 'IDENTICAL_REFERENCE');
    writeFileSync(join(f.dir, 'two.md'), 'IDENTICAL_REFERENCE');
    const link = join(f.dir, 'link.md');
    symlinkSync('one.md', link);
    const runtime = createSkillRuntime({
      discovery: { cwd: f.cwd, harnessHome: join(f.cwd, 'empty') },
    });
    await runtime.discover();
    const context = runtime.bindContext(f.ctx);
    await SkillsViewTool.call({ name: 'release', path: 'link.md' }, context);
    unlinkSync(link);
    symlinkSync('two.md', link);
    await expect(
      SkillsViewTool.call({ name: 'release', path: 'link.md' }, context),
    ).rejects.toThrow('reactivate');
    const records = await f.continuity.exportRecords();
    expect(records[0]?.resources).toHaveLength(1);
    expect(records[0]?.resources[0]?.content).toBe('IDENTICAL_REFERENCE');
    expect(JSON.stringify(f.continuity.diagnostics())).not.toContain(f.cwd);
    runtime.dispose();
  });
  test('raw main-body inspections and canonical aliases never supplement pinned activation guidance', async () => {
    for (const composed of [false, true]) {
      const f = await fixture();
      symlinkSync('SKILL.md', join(f.dir, 'main-alias.md'));
      writeFileSync(
        f.path,
        '---\nname: release\ndescription: Edited raw body\n---\nNEW_RAW_STEPS {{args}}',
      );
      const runtime = createSkillRuntime({
        discovery: { cwd: f.cwd, harnessHome: join(f.cwd, 'empty') },
      });
      await runtime.discover();
      const context = composed ? runtime.bindContext(f.ctx) : f.ctx;
      for (const path of ['SKILL.md', './SKILL.md', 'main-alias.md'])
        await SkillsViewTool.call({ name: 'release', path }, context);
      const records = await f.continuity.exportRecords();
      expect(records[0]?.resources).toEqual([]);
      const resumed = createSkillContinuity({ scope: f.scope, store: f.store });
      const { p, requests } = provider();
      await drain(
        query({
          provider: p,
          model: 'custom',
          messages: [latest],
          systemPrompt: [],
          tools: f.tools,
          maxTokens: 128,
          toolContext: { ...context, skillContinuity: resumed },
        }),
      );
      expect(JSON.stringify(requests[0]?.messages)).toContain(steps);
      expect(JSON.stringify(requests[0]?.messages)).not.toContain('NEW_RAW_STEPS');
      runtime.dispose();
    }
  });
  test('tool-result continuations retain guidance as user text without changing persisted history', async () => {
    const f = await fixture();
    const { p, requests } = provider();
    const history: Message[] = [
      latest,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'result data' }],
      },
    ];
    const before = JSON.stringify(history);
    await drain(
      query({
        provider: p,
        model: 'custom',
        messages: history,
        systemPrompt: [],
        tools: f.tools,
        maxTokens: 128,
        toolContext: f.ctx,
      }),
    );
    expect(JSON.stringify(history)).toBe(before);
    const final = requests[0]?.messages.at(-1);
    expect(final?.role).toBe('user');
    expect(
      final?.content.some((block) => block.type === 'text' && block.text.includes(steps)),
    ).toBe(true);
    expect(
      final?.content.some(
        (block) => block.type === 'tool_result' && block.tool_use_id === 'read-1',
      ),
    ).toBe(true);
    expect(JSON.stringify(requests[0]?.system)).not.toContain(steps);
    const request = requests[0];
    if (!request) throw new Error('missing request');
    const wire = new AnthropicProvider({ apiKey: 'unused-fixture-key' }).buildKwargs(request);
    const content = wire.messages.at(-1)?.content;
    if (!Array.isArray(content)) throw new Error('missing wire content blocks');
    expect(content[0]?.type).toBe('tool_result');
    expect(content.at(-1)?.type).toBe('text');
    expect(JSON.stringify(content.at(-1))).toContain(steps);
  });
  test('native delegation uses only an explicit child guidance scope and preserves the parent tool floor', async () => {
    for (const fork of [false, true]) {
      const f = await fixture();
      const { p, requests } = provider();
      const child = createSkillContinuity({
        scope: { ...f.scope, session: 'child' },
        store: f.store,
      });
      const agent: AgentDefinition = {
        name: 'child',
        description: 'fixture',
        systemPrompt: 'Do the requested read-only work.',
        allowedTools: [],
        maxTurns: 2,
        readOnly: true,
        supportsMissionState: false,
        inheritParentTools: true,
        allowedSubagents: [],
        path: '/fixture/child',
        realpath: '/fixture/child',
        dir: '/fixture',
        source: 'bundle',
        trustTier: 'builtin',
      };
      const scheduler = new SubagentScheduler({
        agents: { agents: [agent], byName: new Map([[agent.name, agent]]) },
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => ({
          transport: p as ResolvedProvider['transport'],
          client: p,
          baseUrl: 'fixture://',
          model: 'custom',
          contextLength: 32_768,
          authType: 'none',
          metadata: { provider: p.name },
        }),
        createChildSession: () => 'child',
        defaultProvider: p.name,
        defaultModel: 'custom',
        maxTokens: 128,
      });
      const result = await scheduler.delegate({
        agentName: 'child',
        prompt: 'Continue the release check.',
        parentSessionId: f.scope.session,
        parentToolPool: f.state.tools,
        parentToolContext: {
          ...f.ctx,
          skillActivation: f.state,
          ...(fork
            ? {
                forkSkillContinuity: async () => {
                  await child.importRecords(await f.continuity.exportRecords(), 'delegation');
                  return child;
                },
              }
            : {}),
        },
      });
      expect(result.summary).toBe('done');
      expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['Read']);
      expect(JSON.stringify(requests[0]?.messages).includes(steps)).toBe(fork);
      expect(JSON.stringify(requests[0]?.system)).not.toContain(steps);
      expect((await f.continuity.exportRecords())[0]?.outcome).toBe('active');
      if (fork) expect(child.diagnostics().some((event) => event.code === 'delegated')).toBe(true);
    }
  });
});
