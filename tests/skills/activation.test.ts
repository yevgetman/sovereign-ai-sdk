import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { normalizeSkillDescriptor } from '@yevgetman/sov-sdk/skills/descriptor';
import { expandSkillPrompt, loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { z } from 'zod';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(body = 'Read the requested file.', tools: string[] = ['Read']) {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-activation-'));
  dirs.push(cwd);
  const dir = join(cwd, '.harness/skills/safe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: safe\ndescription: A safe fixture\nallowedTools: ${JSON.stringify(tools)}\n---\n${body}`,
  );
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty-home') });
  const skill = skills.byName.get('safe');
  if (!skill) throw new Error('fixture failed to load');
  const context: ToolContext = { cwd, sessionId: 'fixture', skills };
  return { cwd, dir, skill, context };
}

function namedTool(name: string, effect: (ctx: ToolContext) => void = () => {}) {
  return buildTool<unknown, unknown>({
    name,
    description: () => name,
    inputSchema: z.unknown(),
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async (_, ctx) => {
      effect(ctx);
      return { data: 'ok' };
    },
  });
}

describe('skill activation permission floors', () => {
  test('a trusted in-memory resolver and empty resource roots perform no disk lookup', async () => {
    const f = await fixture();
    const memorySkill = {
      ...f.skill,
      path: '/nonexistent-host-catalog/SKILL.md',
      realpath: '/nonexistent-host-catalog/SKILL.md',
      dir: '/nonexistent-host-catalog',
      revision: 'memory-v1',
      body: 'Memory {{args}}',
    };
    const state = createSkillActivationState({ tools: [namedTool('Read')] });
    const result = await activateSkill(memorySkill, {
      source: 'user',
      args: 'works',
      toolContext: f.context,
      state,
      allowedResourceRoots: [],
      resolveSkill: async (skill) => skill,
    });
    expect(result.prompt).toBe('Memory works');
    expect(result.activation.revision).toBe('memory-v1');
    expect(result.activation.allowedResourceRoots).toEqual([]);
  });
  test('invocation controls fail before guard approval, inline effects or state changes', async () => {
    const f = await fixture('!`touch NEVER`', ['Bash']);
    let approvals = 0;
    const state = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async () => {
        approvals++;
        return { behavior: 'allow' };
      },
    });
    for (const [flags, source] of [
      [{ 'disable-model-invocation': true }, 'model'],
      [{ 'user-invocable': false }, 'user'],
      [{ context: 'fork' }, 'user'],
    ] as const) {
      const controlled = {
        ...f.skill,
        descriptor: normalizeSkillDescriptor(flags),
        guard: { ...f.skill.guard, action: 'ask' as const },
      };
      await expect(
        activateSkill(controlled, {
          source,
          state,
          toolContext: f.context,
          resolveSkill: async () => controlled,
          allowedResourceRoots: [],
        }),
      ).rejects.toThrow('skill');
    }
    expect(approvals).toBe(0);
    expect(state.activations).toEqual([]);
    expect(existsSync(join(f.dir, 'NEVER'))).toBe(false);
  });
  test('inline output remains literal while original portable argument templates expand', async () => {
    const f = await fixture('!`printf fixture` prose:$0', []);
    const output = '$ARGUMENTS $1 {{args}} !`touch NEVER`';
    const prompt = await expandSkillPrompt(f.skill, {
      args: 'first second',
      cwd: f.cwd,
      runShellCommand: async () => output,
    });
    expect(prompt).toBe(`${output} prose:first`);
    expect(existsSync(join(f.dir, 'NEVER'))).toBe(false);
  });
  test('raw inspection leaves body and references inert; outside reference links fail', async () => {
    const f = await fixture('Shell !`touch body-marker` ${HARNESS_SESSION_ID}');
    writeFileSync(join(f.dir, 'ref.md'), 'Shell !`touch ref-marker` ${HARNESS_SESSION_ID}');
    const outside = join(f.cwd, 'outside.md');
    writeFileSync(outside, 'outside fixture');
    symlinkSync(outside, join(f.dir, 'escape.md'));
    const body = await SkillsViewTool.call({ name: 'safe' }, f.context);
    const ref = await SkillsViewTool.call({ name: 'safe', path: 'ref.md' }, f.context);
    expect(body.data.content).toContain('!`touch body-marker`');
    expect(ref.data.content).toContain('!`touch ref-marker`');
    expect(existsSync(join(f.dir, 'body-marker'))).toBe(false);
    expect(existsSync(join(f.dir, 'ref-marker'))).toBe(false);
    await expect(
      SkillsViewTool.call({ name: 'safe', path: 'escape.md' }, f.context),
    ).rejects.toThrow('escapes skill directory');
  });

  test('a projected SKILL.md file keeps its physical resource namespace', async () => {
    const f = await fixture();
    writeFileSync(join(f.dir, 'ref.md'), 'physical reference');
    const projection = join(f.cwd, '.harness/skills/projected.md');
    symlinkSync(f.skill.path, projection);
    const skill = { ...f.skill, path: projection, dir: dirname(projection) };
    f.context.skills = {
      skills: [skill],
      byName: new Map([[skill.name, skill]]),
    };
    const result = await SkillsViewTool.call({ name: 'safe', path: 'ref.md' }, f.context);
    expect(result.data.content).toBe('physical reference');
    expect(result.data.path).toBe('ref.md');
  });

  test('loader expansion and activation fail closed without a host runner/gate', async () => {
    const f = await fixture('Shell !`touch marker`', ['Bash']);
    await expect(expandSkillPrompt(f.skill, { cwd: f.cwd })).rejects.toThrow(
      'permissioned host runner',
    );
    await expect(
      activateSkill(f.skill, {
        source: 'user',
        toolContext: f.context,
        state: createSkillActivationState({ tools: [BashTool] }),
      }),
    ).rejects.toThrow('host permission callback');
    expect(existsSync(join(f.dir, 'marker'))).toBe(false);
  });

  test('host Bash denial prevents an actual filesystem effect', async () => {
    const f = await fixture('Shell !`touch marker`', ['Bash']);
    let checks = 0;
    const state = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async (tool) => {
        expect(tool.name).toBe('Bash');
        checks++;
        return { behavior: 'deny', reason: 'fixture denies Bash' };
      },
    });
    await expect(
      activateSkill(f.skill, { source: 'user', toolContext: f.context, state }),
    ).rejects.toThrow('fixture denies Bash');
    expect(checks).toBe(1);
    expect(existsSync(join(f.dir, 'marker'))).toBe(false);
    expect(state.activations).toHaveLength(0);
  });

  test('approved dynamic context uses hooks, the skill cwd and an exact revision', async () => {
    const f = await fixture('Shell !`printf approved > marker; cat marker` {{args}}', ['Bash']);
    const hooks: string[] = [];
    const state = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async () => ({ behavior: 'allow' }),
      hookRunner: async (name) => {
        hooks.push(name);
        return { block: false };
      },
    });
    const result = await activateSkill(f.skill, {
      source: 'command',
      args: '!`touch arg-marker`',
      toolContext: f.context,
      state,
    });
    expect(result.prompt).toContain('approved');
    expect(existsSync(join(f.dir, 'marker'))).toBe(true);
    expect(existsSync(join(f.dir, 'arg-marker'))).toBe(false);
    expect(hooks).toContain('PreToolUse');
    expect(hooks).toContain('PostToolUse');
    expect(result.activation.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.activation.source).toBe('command');
  });

  test('scope and input transformations cannot widen dynamic shell execution', async () => {
    const f = await fixture('Shell !`echo permitted`', ['Bash(echo permitted)']);
    const state = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async () => ({ behavior: 'allow', updatedInput: { command: 'touch marker' } }),
    });
    await expect(
      activateSkill(f.skill, { source: 'user', toolContext: f.context, state }),
    ).rejects.toThrow('outside slash-command scope');
    expect(existsSync(join(f.dir, 'marker'))).toBe(false);
    const hookState = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async () => ({ behavior: 'allow' }),
      hookRunner: async (name) =>
        name === 'PreToolUse'
          ? { block: false, updatedInput: { command: 'touch marker' } }
          : { block: false },
    });
    await expect(
      activateSkill(f.skill, { source: 'user', toolContext: f.context, state: hookState }),
    ).rejects.toThrow('outside slash-command scope');
    expect(existsSync(join(f.dir, 'marker'))).toBe(false);
  });

  test('model activation narrows same-batch effects and next request schemas, then expires', async () => {
    const f = await fixture();
    let writes = 0;
    const read = namedTool('Read');
    const write = namedTool('Write', () => {
      writes++;
    });
    const tools = [SkillTool as Tool<unknown, unknown>, read, write];
    const requests: ProviderRequest[] = [];
    let call = 0;
    const provider: LLMProvider = {
      name: 'fixture',
      async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
        requests.push(request);
        call++;
        const message: AssistantMessage = {
          role: 'assistant',
          content:
            call === 1
              ? [
                  {
                    type: 'tool_use',
                    id: 'activation',
                    name: 'SkillTool',
                    input: { skill: 'safe' },
                  },
                  { type: 'tool_use', id: 'write', name: 'Write', input: {} },
                ]
              : [{ type: 'text', text: 'done' }],
        };
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const messages: Message[] = [];
    for await (const event of query({
      provider,
      model: 'fixture',
      systemPrompt: [],
      maxTokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      tools,
      toolContext: f.context,
    }))
      if ('role' in event) messages.push(event);
    expect(writes).toBe(0);
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['Read']);
    expect(JSON.stringify(messages)).toContain('outside slash-command scope');
    expect(f.context.skillActivation).toBeUndefined();
    for await (const _ of query({
      provider,
      model: 'fixture',
      systemPrompt: [],
      maxTokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'next' }] }],
      tools,
      toolContext: f.context,
    })) {
    }
    expect(requests[2]?.tools?.map((tool) => tool.name)).toContain('Write');
  });

  test('query preserves an explicit activation pool and its host denial floor', async () => {
    const f = await fixture();
    let reads = 0;
    const tools = [namedTool('Read', () => reads++), namedTool('Write')];
    const state = createSkillActivationState({
      tools,
      canUseTool: async () => ({ behavior: 'deny', reason: 'original host denies Read' }),
    });
    f.context.skillActivation = state;
    await activateSkill(f.skill, { source: 'user', toolContext: f.context, state });
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      name: 'fixture',
      async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
        requests.push(request);
        const message: AssistantMessage = {
          role: 'assistant',
          content:
            requests.length === 1
              ? [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]
              : [{ type: 'text', text: 'done' }],
        };
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const messages: Message[] = [];
    for await (const event of query({
      provider,
      model: 'fixture',
      systemPrompt: [],
      maxTokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      tools,
      toolContext: f.context,
      canUseTool: async () => ({ behavior: 'allow' }),
    }))
      if ('role' in event) messages.push(event);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['Read']);
    expect(reads).toBe(0);
    expect(JSON.stringify(messages)).toContain('original host denies Read');
    expect(state.activations).toHaveLength(1);
  });

  test('hook input rewrites retain host deny rules even with unrestricted Bash metadata', async () => {
    const f = await fixture('Shell !`echo permitted`', ['Bash']);
    const state = createSkillActivationState({
      tools: [BashTool],
      canUseTool: async (_, input) =>
        (input as { command: string }).command === 'echo permitted'
          ? { behavior: 'allow' }
          : { behavior: 'deny', reason: 'host denies rewritten command' },
      hookRunner: async (name) =>
        name === 'PreToolUse'
          ? { block: false, updatedInput: { command: 'touch marker' } }
          : { block: false },
    });
    await expect(
      activateSkill(f.skill, { source: 'user', toolContext: f.context, state }),
    ).rejects.toThrow('host denies rewritten command');
    expect(existsSync(join(f.dir, 'marker'))).toBe(false);
    expect(state.activations).toHaveLength(0);
  });

  test('activation retains a stricter host child pool and permission ceiling', async () => {
    const f = await fixture('Follow the workflow.', ['Bash', 'AgentTool']);
    const delegate = namedTool('AgentTool');
    f.context.parentToolPool = [delegate];
    f.context.canUseTool = async (tool) =>
      tool.name === 'AgentTool'
        ? { behavior: 'allow' }
        : { behavior: 'deny', reason: 'host child ceiling' };
    const state = createSkillActivationState({
      tools: [BashTool, delegate],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    await activateSkill(f.skill, { source: 'model', toolContext: f.context, state });
    expect(f.context.parentToolPool.map((tool) => tool.name)).toEqual(['AgentTool']);
    expect(
      (
        await f.context.canUseTool(
          BashTool as Tool<unknown, unknown>,
          { command: 'echo permitted' },
          f.context,
        )
      ).behavior,
    ).toBe('deny');
  });

  test('inline context retains the host child ceiling while using the host Bash gate', async () => {
    const f = await fixture('Shell !`echo permitted`', ['Bash', 'AgentTool']);
    const delegate = namedTool('AgentTool');
    f.context.parentToolPool = [delegate];
    f.context.canUseTool = async (tool) =>
      tool.name === 'AgentTool'
        ? { behavior: 'allow' }
        : { behavior: 'deny', reason: 'host child ceiling' };
    let checked = false;
    const bash = {
      ...BashTool,
      call: async (...args: Parameters<typeof BashTool.call>) => {
        const ctx = args[1];
        expect(ctx.parentToolPool?.map((tool) => tool.name)).toEqual(['AgentTool']);
        expect(
          (await ctx.canUseTool?.(BashTool as Tool<unknown, unknown>, args[0], ctx))?.behavior,
        ).toBe('deny');
        checked = true;
        return BashTool.call(...args);
      },
    };
    const state = createSkillActivationState({
      tools: [bash, delegate],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const result = await activateSkill(f.skill, { source: 'user', toolContext: f.context, state });
    expect(result.prompt).toContain('permitted');
    expect(checked).toBe(true);
  });

  test('delegation inherits the narrowed pool and input-pattern floor', async () => {
    const f = await fixture('Follow the workflow.', ['Bash(echo permitted)', 'AgentTool']);
    let childChecked = false;
    const delegate = namedTool('AgentTool', (ctx) => {
      expect(ctx.parentToolPool?.map((tool) => tool.name)).toEqual(['Bash', 'AgentTool']);
      childChecked = true;
    });
    const state = createSkillActivationState({
      tools: [BashTool, delegate, namedTool('Write')],
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    f.context.skillActivation = state;
    await activateSkill(f.skill, { source: 'model', toolContext: f.context, state });
    await delegate.call({}, f.context);
    expect(childChecked).toBe(true);
    expect(
      (
        await f.context.canUseTool?.(
          BashTool as Tool<unknown, unknown>,
          { command: 'touch forbidden' },
          f.context,
        )
      )?.behavior,
    ).toBe('deny');
    expect(
      (
        await f.context.canUseTool?.(
          BashTool as Tool<unknown, unknown>,
          { command: 'echo permitted' },
          f.context,
        )
      )?.behavior,
    ).toBe('allow');
  });
});
