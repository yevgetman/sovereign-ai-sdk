import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import { runTools } from '@yevgetman/sov-sdk/core/orchestrator';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { wrapCanUseToolWithTransformers } from '@yevgetman/sov-sdk/permissions/inputTransformer';
import { redactSecretsTransformer } from '@yevgetman/sov-sdk/permissions/redactSecretsTransformer';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { activateSkill, createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { FileWriteTool } from '@yevgetman/sov-sdk/tools/FileWriteTool';
import { z } from 'zod';

const write = FileWriteTool as unknown as Tool<unknown, unknown>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skill: Skill = {
  name: 'memory-safe',
  description: 'Child permission fixture',
  whenToUse: '',
  allowedTools: ['FileWrite', 'Delegate'],
  path: '/memory/SKILL.md',
  realpath: '/memory/SKILL.md',
  dir: '/memory',
  source: 'project',
  trustTier: 'trusted',
  allowShellInterpolation: false,
  metadata: {
    harness: {
      requiresToolsets: [],
      requiresTools: [],
      fallbackForToolsets: [],
      fallbackForTools: [],
    },
  },
  guard: { action: 'allow', findings: [] },
  body: 'Use the approved child tools.',
};

function context(): ToolContext {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-child-permissions-'));
  dirs.push(cwd);
  return {
    cwd,
    sessionId: 'parent',
    skills: { skills: [skill], byName: new Map([[skill.name, skill]]) },
  };
}

async function writeWithChildGate(ctx: ToolContext, content: string): Promise<void> {
  for await (const _ of runTools(
    [
      {
        type: 'tool_use',
        id: 'child-write',
        name: 'FileWrite',
        input: { path: join(ctx.cwd, 'result.txt'), content },
      },
    ],
    { cwd: ctx.cwd, sessionId: 'child' },
    [FileWriteTool],
    ctx.canUseTool,
  )) {
  }
}

async function runDelegate(
  ctx: ToolContext,
  gate: CanUseTool,
  content: string,
  activateFirst = false,
): Promise<void> {
  const delegate = buildTool<unknown, unknown>({
    name: 'Delegate',
    description: () => 'Run an isolated child through the inherited host permission callback.',
    inputSchema: z.unknown(),
    call: async (_, parent) => {
      if (activateFirst && parent.skillActivation) {
        for (let i = 0; i < 2; i++) {
          await activateSkill(skill, {
            source: 'model',
            state: parent.skillActivation,
            toolContext: parent,
            resolveSkill: async (current) => current,
            allowedResourceRoots: [],
          });
        }
      }
      await writeWithChildGate(parent, content);
      return { data: 'done' };
    },
  });
  let requests = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      const message: AssistantMessage = {
        role: 'assistant',
        content:
          requests++ === 0
            ? [{ type: 'tool_use', id: 'delegate', name: 'Delegate', input: {} }]
            : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  for await (const _ of query({
    provider,
    model: 'fixture',
    systemPrompt: [],
    maxTokens: 256,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Delegate the write.' }] }],
    tools: [delegate, write],
    toolContext: ctx,
    canUseTool: gate,
  })) {
  }
}

test('skill-enabled query preserves parent secret redaction in delegated writes', async () => {
  const ctx = context();
  ctx.canUseTool = async () => ({ behavior: 'allow' });
  const gate = wrapCanUseToolWithTransformers(
    async () => ({ behavior: 'allow' }),
    [redactSecretsTransformer],
  );
  const secret = `ghp_${'a'.repeat(36)}`;
  await runDelegate(ctx, gate, secret);
  const result = readFileSync(join(ctx.cwd, 'result.txt'), 'utf8');
  expect(result).not.toContain(secret);
  expect(result).toContain('REDACTED');
});

test('skill-enabled query denies a child callback that rewrites host-authorized input', async () => {
  const ctx = context();
  ctx.canUseTool = async (_, input) => ({
    behavior: 'allow',
    updatedInput: { ...(input as object), content: 'forbidden' },
  });
  let writes = 0;
  const gate: CanUseTool = async (tool, input) => {
    if (tool.name === 'FileWrite') {
      writes++;
      return (input as { content: string }).content === 'approved'
        ? { behavior: 'allow' }
        : { behavior: 'deny', reason: 'host denied rewritten content' };
    }
    return { behavior: 'allow' };
  };
  await runDelegate(ctx, gate, 'approved');
  expect(writes).toBeGreaterThan(0);
  expect(() => readFileSync(join(ctx.cwd, 'result.txt'), 'utf8')).toThrow();
});

test('direct activation retains parent host denial in the published child callback', async () => {
  const ctx = context();
  ctx.canUseTool = async () => ({ behavior: 'allow' });
  const state = createSkillActivationState({
    tools: [FileWriteTool],
    canUseTool: async () => ({ behavior: 'deny', reason: 'host denies all writes' }),
  });
  await activateSkill(skill, {
    source: 'user',
    state,
    toolContext: ctx,
    resolveSkill: async (current) => current,
    allowedResourceRoots: [],
  });
  await writeWithChildGate(ctx, 'forbidden');
  expect(() => readFileSync(join(ctx.cwd, 'result.txt'), 'utf8')).toThrow();
});

test('a native AgentTool child retains parent secret redaction through the scheduler', async () => {
  const ctx = context();
  ctx.canUseTool = async () => ({ behavior: 'allow' });
  const secret = `ghp_${'a'.repeat(36)}`;
  const agent: AgentDefinition = {
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
  };
  const agents = { agents: [agent], byName: new Map([[agent.name, agent]]) };
  ctx.agents = agents;
  let childRequests = 0;
  const childProvider: LLMProvider = {
    name: 'fixture',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      const message: AssistantMessage = {
        role: 'assistant',
        content:
          childRequests++ === 0
            ? [
                {
                  type: 'tool_use',
                  id: 'native-write',
                  name: 'FileWrite',
                  input: { path: join(ctx.cwd, 'result.txt'), content: secret },
                },
              ]
            : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  ctx.subagentScheduler = new SubagentScheduler({
    agents,
    laneSemaphores: new LaneSemaphores({}),
    pathLock: new PathLockManager(),
    resolveProvider: () => ({
      transport: childProvider as unknown as ResolvedProvider['transport'],
      client: {},
      baseUrl: 'fake://',
      model: 'fixture',
      contextLength: 32_000,
      authType: 'none',
      metadata: { provider: 'fixture' },
    }),
    createChildSession: () => 'native-child',
    defaultProvider: 'fixture',
    defaultModel: 'fixture',
    maxTokens: 256,
  });
  let parentRequests = 0;
  const parentProvider: LLMProvider = {
    name: 'fixture',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      const message: AssistantMessage = {
        role: 'assistant',
        content:
          parentRequests++ === 0
            ? [
                {
                  type: 'tool_use',
                  id: 'native-delegate',
                  name: 'AgentTool',
                  input: { subagent_type: agent.name, prompt: 'Write the result.' },
                },
              ]
            : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const gate = wrapCanUseToolWithTransformers(
    async () => ({ behavior: 'allow' }),
    [redactSecretsTransformer],
  );
  for await (const _ of query({
    provider: parentProvider,
    model: 'fixture',
    systemPrompt: [],
    maxTokens: 256,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Delegate the write.' }] }],
    tools: [AgentTool, write],
    toolContext: ctx,
    canUseTool: gate,
  })) {
  }
  const result = readFileSync(join(ctx.cwd, 'result.txt'), 'utf8');
  expect(result).not.toContain(secret);
  expect(result).toContain('REDACTED');
});

test('repeated activation does not repeat an always-transforming host inside its child gate', async () => {
  const ctx = context();
  let checks = 0;
  const gate: CanUseTool = async (_, input) => {
    checks++;
    return { behavior: 'allow', updatedInput: { ...(input as object), content: 'authorized' } };
  };
  const state = createSkillActivationState({ tools: [FileWriteTool], canUseTool: gate });
  ctx.canUseTool = gate;
  for (let i = 0; i < 2; i++) {
    await activateSkill(skill, {
      source: 'user',
      state,
      toolContext: ctx,
      resolveSkill: async (current) => current,
      allowedResourceRoots: [],
    });
  }
  await writeWithChildGate(ctx, 'original');
  expect(readFileSync(join(ctx.cwd, 'result.txt'), 'utf8')).toBe('authorized');
  expect(checks).toBe(1);
});

test('activation rebuilds a query-owned child gate without repeating its parent transformer', async () => {
  const ctx = context();
  ctx.canUseTool = async () => ({ behavior: 'allow' });
  let writes = 0;
  const gate: CanUseTool = async (tool, input) => {
    if (tool.name !== 'FileWrite') return { behavior: 'allow' };
    writes++;
    return { behavior: 'allow', updatedInput: { ...(input as object), content: 'authorized' } };
  };
  await runDelegate(ctx, gate, 'original', true);
  expect(readFileSync(join(ctx.cwd, 'result.txt'), 'utf8')).toBe('authorized');
  expect(writes).toBe(1);
});
