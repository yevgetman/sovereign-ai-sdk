import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogicalTurnRecord } from '@yevgetman/sov-sdk/agent/logicalTurn';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import {
  InMemorySkillContinuityStore,
  createSkillContinuity,
} from '@yevgetman/sov-sdk/skills/continuity';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import type { Runtime } from '../../src/server/runtime.js';
import type { SessionContext } from '../../src/server/sessionContext.js';
import {
  clearSkillCeiling,
  composeTurn,
  restoreLogicalTurnSkillCeiling,
  stampLogicalTurnSkillCeiling,
} from '../../src/server/turnComposition.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tool(name: string, effect: () => void = () => {}): Tool<unknown, unknown> {
  return buildTool<unknown, unknown>({
    name,
    description: () => name,
    inputSchema: z.object({}),
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => {
      effect();
      return { data: 'ok' };
    },
  });
}

async function writeSkill(
  cwd: string,
  name: string,
  allowedTools: readonly string[],
): Promise<void> {
  const dir = join(cwd, '.harness/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture\nallowedTools: ${JSON.stringify(allowedTools)}\n---\nUse ${name}.\n`,
  );
}

function scripted(replies: AssistantMessage[]) {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'fixture',
    async *stream(request) {
      requests.push(structuredClone(request));
      const message = replies.shift();
      if (!message) throw new Error('scripted provider ran out of replies');
      yield { type: 'assistant_message' as const, message };
      const toolUse = message.content.some((block) => block.type === 'tool_use');
      yield {
        type: 'message_stop' as const,
        stop_reason: toolUse ? ('tool_use' as const) : ('max_tokens' as const),
      };
      return message;
    },
  };
  return { provider, requests };
}

function call(name: string, input: unknown = {}): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input }] };
}

const textStop: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'partial' }],
};

async function harness(skillsToWrite: { name: string; allowedTools: readonly string[] }[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-ceiling-'));
  dirs.push(cwd);
  for (const skill of skillsToWrite) await writeSkill(cwd, skill.name, skill.allowedTools);
  const skills = await loadSkills({ cwd, harnessHome: join(cwd, 'empty-home') });
  let bashRuns = 0;
  const bash = tool('Bash', () => {
    bashRuns++;
  });
  const read = tool('Read');
  const pool = [SkillTool as Tool<unknown, unknown>, read, bash];
  const continuity = createSkillContinuity({
    scope: { profile: 'profile', owner: 'owner', session: 'session-1' },
    store: new InMemorySkillContinuityStore(),
  });
  const sessionCtx = {
    sessionId: 'session-1',
    skillContinuity: continuity,
    effort: 'off',
    memoryManager: { prefetchSnapshot: async () => '' },
    subdirectoryHintState: { touched: new Set<string>() },
    projectScope: { kind: 'none' },
  } as unknown as SessionContext;
  const runtime = {
    model: 'fixture',
    maxTokens: 32,
    cwd,
    harnessHome: join(cwd, 'empty-home'),
    systemSegments: [],
    toolPool: pool,
    skills,
    agents: { agents: [], byName: new Map() },
    subagentScheduler: {},
    taskManager: {},
    laneRegistry: {},
    injectedSettings: {},
    getSessionContext: () => sessionCtx,
  } as unknown as Runtime;
  return { cwd, bash, bashRuns: () => bashRuns, runtime, sessionCtx };
}

async function runSegment(input: {
  runtime: Runtime;
  sessionCtx: SessionContext;
  provider: LLMProvider;
  history: Message[];
  turnKey: string;
  continuation: boolean;
  bash: Tool<unknown, unknown>;
  cwd: string;
}) {
  const composed = composeTurn({
    runtime: input.runtime,
    provider: input.provider,
    persistence: { mode: 'sdk-store', sessionStore: createInMemorySessionStore() },
    canUseTool: async () => ({ behavior: 'allow' }),
    skillActivationTurnId: input.turnKey,
    manageSkillContinuity: true,
    rethrow: true,
  });
  const hop = composed.perTurn({
    sessionId: 'session-1',
    sessionCtx: input.sessionCtx,
    continuation: input.continuation,
    logicalTurn: true,
    maxTurns: 6,
  });
  const decision = await hop.canUseTool?.(
    input.bash,
    {},
    {
      cwd: input.cwd,
      sessionId: 'session-1',
    },
  );
  const seen: Message[] = [];
  for await (const event of composed.agent.run(input.history, {
    ...hop,
    persistCompletedMessages: false,
  })) {
    if (event && typeof event === 'object' && 'role' in event) seen.push(event as Message);
  }
  return { composed, decision, seen };
}

test('a max_tokens continuation keeps the read-only skill ceiling', async () => {
  const env = await harness([{ name: 'reader', allowedTools: ['Read'] }]);
  const first = scripted([call('SkillTool', { skill: 'reader' }), textStop]);
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }];
  await runSegment({
    ...env,
    provider: first.provider,
    history,
    turnKey: 'logical-turn-a',
    continuation: false,
  });
  expect(first.requests.at(-1)?.tools?.map((item) => item.name)).toEqual(['Read']);

  const second = scripted([call('Bash'), textStop]);
  const continued = await runSegment({
    ...env,
    provider: second.provider,
    history: [
      ...history,
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Continue the interrupted answer.' }],
      },
    ],
    turnKey: 'logical-turn-a',
    continuation: true,
  });
  expect(second.requests[0]?.tools?.map((item) => item.name)).toEqual(['Read']);
  expect(continued.decision?.behavior).toBe('deny');
  expect(env.bashRuns()).toBe(0);
  expect(JSON.stringify(continued.seen)).not.toContain('"data":"ok"');

  const other = scripted([textStop]);
  const separate = await runSegment({
    ...env,
    provider: other.provider,
    history: [{ role: 'user', content: [{ type: 'text', text: 'new turn' }] }],
    turnKey: 'logical-turn-other',
    continuation: false,
  });
  expect(other.requests[0]?.tools?.map((item) => item.name).sort()).toEqual([
    'Bash',
    'Read',
    'SkillTool',
  ]);
  expect(separate.decision?.behavior).toBe('allow');
});

test('a later unrestricted skill does not widen the turn ceiling', async () => {
  const env = await harness([
    { name: 'reader', allowedTools: ['Read', 'SkillTool'] },
    { name: 'open', allowedTools: [] },
  ]);
  const script = scripted([
    call('SkillTool', { skill: 'reader' }),
    call('SkillTool', { skill: 'open' }),
    textStop,
  ]);
  await runSegment({
    ...env,
    provider: script.provider,
    history: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    turnKey: 'logical-turn-b',
    continuation: false,
  });
  const next = scripted([textStop]);
  const continued = await runSegment({
    ...env,
    provider: next.provider,
    history: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    ],
    turnKey: 'logical-turn-b',
    continuation: true,
  });
  expect(continued.composed.tools.map((item) => item.name).sort()).toEqual(['Read', 'SkillTool']);
  expect(next.requests[0]?.tools?.map((item) => item.name).sort()).toEqual(['Read', 'SkillTool']);
  expect(continued.decision?.behavior).toBe('deny');
  expect(env.bashRuns()).toBe(0);
});

test('two skill allow-lists intersect and do not widen', async () => {
  const env = await harness([
    { name: 'broad', allowedTools: ['Read', 'Bash', 'SkillTool'] },
    { name: 'tight', allowedTools: ['Read'] },
  ]);
  const script = scripted([
    call('SkillTool', { skill: 'broad' }),
    call('SkillTool', { skill: 'tight' }),
    textStop,
  ]);
  await runSegment({
    ...env,
    provider: script.provider,
    history: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    turnKey: 'logical-turn-intersect',
    continuation: false,
  });
  const next = scripted([call('Bash'), textStop]);
  const continued = await runSegment({
    ...env,
    provider: next.provider,
    history: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    ],
    turnKey: 'logical-turn-intersect',
    continuation: true,
  });
  expect(next.requests[0]?.tools?.map((item) => item.name)).toEqual(['Read']);
  expect(continued.decision?.behavior).toBe('deny');
  expect(env.bashRuns()).toBe(0);
});

test('a resumed logical turn row keeps the skill ceiling', async () => {
  const env = await harness([{ name: 'reader', allowedTools: ['Read'] }]);
  const script = scripted([call('SkillTool', { skill: 'reader' }), textStop]);
  const sourceKey = 'logical-turn-persist';
  await runSegment({
    ...env,
    provider: script.provider,
    history: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    turnKey: sourceKey,
    continuation: false,
  });
  const record = {
    version: 1 as const,
    logicalTurnId: 'lt-ceiling',
    sessionId: 'session-1',
    activeSessionId: 'session-1',
    compactedSessionIds: [],
    binding: { provider: 'fixture', model: 'fixture', cwd: env.cwd },
    bindingDigest: 'digest',
    segmentLimit: 4,
    logicalModelCallLimit: 10,
    status: 'continuing' as const,
    repeatedNoProgress: 0,
    runtimeContinuationIds: [],
    counters: {
      segments: 1,
      modelCalls: 1,
      toolCalls: 1,
      providerRetries: 0,
      contextRecoveries: 0,
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
    },
    createdAt: 1,
    updatedAt: 2,
  } satisfies LogicalTurnRecord;
  stampLogicalTurnSkillCeiling(record, sourceKey);
  clearSkillCeiling(sourceKey);
  const root = mkdtempSync(join(tmpdir(), 'skill-ceiling-row-'));
  dirs.push(root);
  const db = SessionDb.open({ path: join(root, 'sessions.db') });
  try {
    db.createLogicalTurn(record);
    const loaded = db.loadLogicalTurn('lt-ceiling');
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    const resumedKey = 'logical-turn-resumed';
    restoreLogicalTurnSkillCeiling(loaded, resumedKey);
    const resumed = scripted([textStop]);
    const continued = await runSegment({
      ...env,
      provider: resumed.provider,
      history: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      ],
      turnKey: resumedKey,
      continuation: true,
    });
    expect(resumed.requests[0]?.tools?.map((item) => item.name)).toEqual(['Read']);
    expect(continued.decision?.behavior).toBe('deny');
    expect(env.bashRuns()).toBe(0);
  } finally {
    db.close();
    clearSkillCeiling('logical-turn-resumed');
  }
});
