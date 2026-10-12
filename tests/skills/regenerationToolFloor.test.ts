import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentConfig,
  type PerTurn,
  type RunResult,
  createAgent,
} from '@yevgetman/sov-sdk/agent/createAgent';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import { runTools } from '@yevgetman/sov-sdk/core/orchestrator';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';
import { FileWriteTool } from '@yevgetman/sov-sdk/tools/FileWriteTool';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { z } from 'zod';

const dirs: string[] = [];
afterEach(() => {
  for (const cwd of dirs.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

function text(value: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: value }] };
}

function use(name: string, input: unknown, id = name): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function provider(
  scripts: (AssistantMessage | (() => AssistantMessage))[],
  requests: ProviderRequest[] = [],
): LLMProvider {
  const queue = scripts.slice();
  return {
    name: 'fake',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      const next = queue.shift();
      if (!next) throw new Error('fixture provider exhausted');
      const message = typeof next === 'function' ? next() : next;
      yield { type: 'assistant_message', message };
      yield {
        type: 'message_stop',
        stop_reason: message.content.some((block) => block.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
      };
      return message;
    },
  };
}

async function fixture(allowedTools: string[] = ['SkillTool']) {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-regeneration-floor-'));
  dirs.push(cwd);
  const dir = join(cwd, '.harness/skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'restricted.md'),
    `---\nname: restricted\ndescription: Restricted workflow\nallowedTools: ${JSON.stringify(allowedTools)}\n---\nUse only the declared tools.`,
  );
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty-home') });
  const context: ToolContext = { cwd, sessionId: 'regeneration', skills };
  const turn: PerTurn = {
    sessionId: context.sessionId,
    toolContext: context,
    canUseTool: async () => ({ behavior: 'allow' }),
  };
  return { cwd, context, turn, path: join(cwd, 'forbidden.txt') };
}

const regenerate: AgentConfig['conduct'] = {
  outputGuard: {
    onFinal: (message) =>
      message.content.some((block) => block.type === 'text' && block.text === 'retry')
        ? { action: 'regenerate' }
        : { action: 'pass' },
  },
};

async function drain(gen: AsyncGenerator<StreamEvent | Message, RunResult>): Promise<RunResult> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

const activate = () => use('SkillTool', { skill: 'restricted' });
const tools = [SkillTool, FileWriteTool] as Tool<unknown, unknown>[];

test('a model-activated Write denial survives regeneration and expires at the next run', async () => {
  const f = await fixture();
  const requests: ProviderRequest[] = [];
  const agent = createAgent({
    provider: provider(
      [
        activate(),
        text('retry'),
        use('FileWrite', { path: f.path, content: 'UNAUTHORIZED_EFFECT' }),
        text('done'),
      ],
      requests,
    ),
    model: 'fake',
    maxTokens: 128,
    cwd: f.cwd,
    tools,
    conduct: regenerate,
  });
  const result = await drain(agent.run('Activate the restricted workflow', f.turn));
  expect(result.terminal.reason).toBe('completed');
  expect(requests).toHaveLength(4);
  expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['SkillTool']);
  expect(requests[2]?.tools?.map((tool) => tool.name)).toEqual(['SkillTool']);
  expect(existsSync(f.path)).toBe(false);
  expect(f.context.skillActivation).toBeUndefined();
  const next = await drain(
    agent.run('Ordinary next turn', {
      ...f.turn,
      provider: provider(
        [use('FileWrite', { path: f.path, content: 'AUTHORIZED_NEXT_RUN' }), text('done')],
        requests,
      ),
    }),
  );
  expect(next.terminal.reason).toBe('completed');
  expect(readFileSync(f.path, 'utf8')).toBe('AUTHORIZED_NEXT_RUN');
  expect(requests[4]?.tools?.map((tool) => tool.name)).toEqual(['SkillTool', 'FileWrite']);
});

test.each(['host', 'hook'] as const)(
  'input-pattern floors survive regeneration and a %s rewrite',
  async (rewrite) => {
    const f = await fixture(['SkillTool', 'Bash(echo permitted)']);
    const marker = join(f.cwd, 'marker');
    let rewritten = 0;
    const agent = createAgent({
      provider: provider([
        activate(),
        text('retry'),
        use('Bash', { command: 'echo permitted' }),
        text('done'),
      ]),
      model: 'fake',
      maxTokens: 128,
      cwd: f.cwd,
      tools: [SkillTool, BashTool] as Tool<unknown, unknown>[],
      conduct: regenerate,
      ...(rewrite === 'hook'
        ? {
            hookRunner: async (stage, payload) => {
              if (
                stage === 'PreToolUse' &&
                'tool_name' in payload &&
                payload.tool_name === 'Bash'
              ) {
                rewritten++;
                return { block: false, updatedInput: { command: `touch ${marker}` } };
              }
              return { block: false };
            },
          }
        : {}),
    });
    const result = await drain(
      agent.run('Activate the restricted workflow', {
        ...f.turn,
        canUseTool: async (tool) => {
          if (rewrite === 'host' && tool.name === 'Bash') {
            rewritten++;
            return { behavior: 'allow', updatedInput: { command: `touch ${marker}` } };
          }
          return { behavior: 'allow' };
        },
      }),
    );
    expect(result.terminal.reason).toBe('completed');
    expect(rewritten).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(result.messages)).toContain('outside slash-command scope');
  },
);

test('regenerated calls still ask the host instead of carrying an earlier approval', async () => {
  const f = await fixture(['SkillTool', 'FileWrite']);
  let approvals = 0;
  const agent = createAgent({
    provider: provider([
      activate(),
      use('FileWrite', { path: f.path, content: 'APPROVED_FIRST' }),
      text('retry'),
      use('FileWrite', { path: f.path, content: 'DENIED_RETRY' }),
      text('done'),
    ]),
    model: 'fake',
    maxTokens: 128,
    cwd: f.cwd,
    tools,
    conduct: regenerate,
  });
  const result = await drain(
    agent.run('Activate the restricted workflow', {
      ...f.turn,
      canUseTool: async (tool) =>
        tool.name !== 'FileWrite' || ++approvals === 1
          ? { behavior: 'allow' }
          : { behavior: 'deny', reason: 'fresh host denial on retry' },
    }),
  );
  expect(result.terminal.reason).toBe('completed');
  expect(approvals).toBe(2);
  expect(readFileSync(f.path, 'utf8')).toBe('APPROVED_FIRST');
  expect(JSON.stringify(result.messages)).toContain('fresh host denial on retry');
});

test('regeneration rebuilds an explicit activation child gate without duplicating its host', async () => {
  const f = await fixture(['SkillTool', 'Delegate', 'FileWrite']);
  let writes = 0;
  const delegate = buildTool<unknown, unknown>({
    name: 'Delegate',
    description: () => 'Write through the inherited child gate.',
    inputSchema: z.unknown(),
    call: async (_, parent) => {
      for await (const _ of runTools(
        [
          {
            type: 'tool_use',
            id: 'write',
            name: 'FileWrite',
            input: { path: f.path, content: 'original' },
          },
        ],
        { cwd: f.cwd, sessionId: 'child' },
        [FileWriteTool],
        parent.canUseTool,
      )) {
      }
      return { data: 'done' };
    },
  });
  const host = async (tool: Tool<unknown, unknown>, input: unknown) => {
    if (tool.name !== 'FileWrite') return { behavior: 'allow' as const };
    writes++;
    return {
      behavior: 'allow' as const,
      updatedInput: { ...(input as object), content: 'authorized' },
    };
  };
  const state = createSkillActivationState({
    tools: [SkillTool, delegate, FileWriteTool],
    canUseTool: host,
  });
  f.context.canUseTool = host;
  const skill = f.context.skills?.byName.get('restricted');
  if (!skill) throw new Error('fixture skill is missing');
  await activateSkill(skill, { source: 'user', state, toolContext: f.context });
  f.context.skillActivation = state;
  const agent = createAgent({
    provider: provider([text('retry'), use('Delegate', {}), text('done')]),
    model: 'fake',
    maxTokens: 128,
    tools: [SkillTool, delegate, FileWriteTool] as Tool<unknown, unknown>[],
    conduct: regenerate,
  });
  const result = await drain(
    agent.run('Use the approved workflow', { sessionId: 'parent', toolContext: f.context }),
  );
  expect(result.terminal.reason).toBe('completed');
  expect(writes).toBe(1);
  expect(readFileSync(f.path, 'utf8')).toBe('authorized');
});

test('regeneration cannot promote an explicit state with no host approval callback', async () => {
  const f = await fixture(['SkillTool', 'Bash']);
  writeFileSync(
    join(f.cwd, '.harness/skills/restricted.md'),
    `---\nname: restricted\ndescription: Shell workflow\nallowedTools: [SkillTool, Bash]\n---\nShell !\`touch ${f.path}\``,
  );
  f.context.skillActivation = createSkillActivationState({ tools: [SkillTool, BashTool] });
  const agent = createAgent({
    provider: provider([text('retry'), activate(), text('done')]),
    model: 'fake',
    maxTokens: 128,
    tools: [SkillTool, BashTool] as Tool<unknown, unknown>[],
    conduct: regenerate,
  });
  const result = await drain(
    agent.run('Use the workflow', { sessionId: 'parent', toolContext: f.context }),
  );
  expect(result.terminal.reason).toBe('completed');
  expect(existsSync(f.path)).toBe(false);
  expect(JSON.stringify(result.messages)).toContain('host permission callback');
});

test('a repeated regeneration verdict remains bounded without restoring Write', async () => {
  const f = await fixture();
  const requests: ProviderRequest[] = [];
  const agent = createAgent({
    provider: provider(
      [
        activate(),
        text('retry'),
        use('FileWrite', { path: f.path, content: 'UNAUTHORIZED_EFFECT' }),
        text('retry'),
      ],
      requests,
    ),
    model: 'fake',
    maxTokens: 128,
    cwd: f.cwd,
    tools,
    conduct: regenerate,
  });
  const result = await drain(agent.run('Activate the restricted workflow', f.turn));
  expect(result.terminal.reason).toBe('completed');
  expect(requests).toHaveLength(4);
  expect(requests[2]?.tools?.map((tool) => tool.name)).toEqual(['SkillTool']);
  expect(existsSync(f.path)).toBe(false);
  expect(JSON.stringify(result.finalAssistant)).not.toContain('retry');
});

test.each(['error', 'cancelled'] as const)(
  '%s during retry releases the floor before the next run',
  async (failure) => {
    const f = await fixture();
    const controller = new AbortController();
    const agent = createAgent({
      provider: provider([
        activate(),
        text('retry'),
        () => {
          if (failure === 'error') throw new Error('retry provider failed');
          controller.abort();
          return use('FileWrite', { path: f.path, content: 'UNAUTHORIZED_EFFECT' });
        },
      ]),
      model: 'fake',
      maxTokens: 128,
      cwd: f.cwd,
      tools,
      conduct: regenerate,
    });
    const result = await drain(
      agent.run('Activate the restricted workflow', { ...f.turn, signal: controller.signal }),
    );
    expect(result.terminal.reason).toBe(failure === 'error' ? 'error' : 'interrupted');
    expect(existsSync(f.path)).toBe(false);
    const next = await drain(
      agent.run('Ordinary next turn', {
        ...f.turn,
        provider: provider([
          use('FileWrite', { path: f.path, content: 'AUTHORIZED_NEXT_RUN' }),
          text('done'),
        ]),
      }),
    );
    expect(next.terminal.reason).toBe('completed');
    expect(readFileSync(f.path, 'utf8')).toBe('AUTHORIZED_NEXT_RUN');
  },
);

test('consumer abandonment after activation does not restrict the next run', async () => {
  const f = await fixture();
  const agent = createAgent({
    provider: provider([activate(), text('done')]),
    model: 'fake',
    maxTokens: 128,
    cwd: f.cwd,
    tools,
    conduct: regenerate,
  });
  const gen = agent.run('Activate the restricted workflow', f.turn);
  for (;;) {
    const step = await gen.next();
    if (step.done) throw new Error('fixture ended before activation');
    if ('role' in step.value && step.value.role === 'user') break;
  }
  await gen.return(undefined as unknown as RunResult);
  const next = await drain(
    agent.run('Ordinary next turn', {
      ...f.turn,
      provider: provider([
        use('FileWrite', { path: f.path, content: 'AUTHORIZED_NEXT_RUN' }),
        text('done'),
      ]),
    }),
  );
  expect(next.terminal.reason).toBe('completed');
  expect(readFileSync(f.path, 'utf8')).toBe('AUTHORIZED_NEXT_RUN');
});

test.each(['native', 'subprocess'] as const)(
  'a regenerated parent keeps the %s child ceiling',
  async (executor) => {
    const f = await fixture(['SkillTool', 'AgentTool']);
    const child: AgentDefinition = {
      name: 'writer',
      description: 'Child writer',
      systemPrompt: 'Write the result.',
      allowedTools: ['FileWrite'],
      maxTurns: 3,
      readOnly: false,
      supportsMissionState: false,
      inheritParentTools: false,
      allowedSubagents: [],
      path: '/memory/writer.md',
      realpath: '/memory/writer.md',
      dir: '/memory',
      source: 'project',
      trustTier: 'trusted',
      ...(executor === 'subprocess' ? { role: 'subscription-executor' } : {}),
    };
    const agents = { agents: [child], byName: new Map([[child.name, child]]) };
    f.context.agents = agents;
    const childRequests: ProviderRequest[] = [];
    let subprocessCalls = 0;
    f.context.subagentScheduler = new SubagentScheduler({
      agents,
      laneSemaphores: new LaneSemaphores({}),
      pathLock: new PathLockManager(),
      defaultProvider: 'fake',
      defaultModel: 'fake',
      maxTokens: 128,
      createChildSession: () => 'native-child',
      resolveProvider: () => ({
        transport: provider(
          [use('FileWrite', { path: f.path, content: 'CHILD_EFFECT' }), text('done')],
          childRequests,
        ) as unknown as ResolvedProvider['transport'],
        client: {},
        baseUrl: 'fake://',
        model: 'fake',
        contextLength: 32_000,
        authType: 'none',
        metadata: { provider: 'fake' },
      }),
      subscriptionExecutor: { enabled: true, engine: 'claude-code', permissionMode: 'plan' },
      runSubprocessExecutor: async () => {
        subprocessCalls++;
        writeFileSync(f.path, 'CHILD_EFFECT');
        return {
          terminal: { reason: 'completed' },
          finalAssistant: text('done'),
          iterationsUsed: 1,
          toolCallCount: 0,
          distinctToolNames: [],
          messages: [],
        };
      },
    });
    const delegate = () =>
      use('AgentTool', { subagent_type: child.name, prompt: 'Write the result.' });
    const agent = createAgent({
      provider: provider([activate(), text('retry'), delegate(), text('done')]),
      model: 'fake',
      maxTokens: 128,
      cwd: f.cwd,
      tools: [SkillTool, AgentTool, FileWriteTool] as Tool<unknown, unknown>[],
      conduct: regenerate,
    });
    const result = await drain(agent.run('Activate the restricted workflow', f.turn));
    expect(result.terminal.reason).toBe('completed');
    expect(existsSync(f.path)).toBe(false);
    expect(subprocessCalls).toBe(0);
    if (executor === 'native') expect(childRequests[0]?.tools ?? []).toEqual([]);
    else
      expect(JSON.stringify(result.messages)).toContain(
        'cannot be enforced by the subprocess executor',
      );
    const next = await drain(
      agent.run('Ordinary next turn', {
        ...f.turn,
        provider: provider([delegate(), text('done')]),
      }),
    );
    expect(next.terminal.reason).toBe('completed');
    expect(readFileSync(f.path, 'utf8')).toBe('CHILD_EFFECT');
    if (executor === 'subprocess') expect(subprocessCalls).toBe(1);
  },
);
