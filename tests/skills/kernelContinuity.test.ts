import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { createSkillContinuity } from '@yevgetman/sov-sdk/skills/continuity';
import { type SkillRuntime, createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import {
  SessionSkillContinuityStore,
  buildSovSkillContinuity,
  skillContinuityProfileKey,
} from '../../src/skills/continuity.js';

const roots: string[] = [];
const databases = new Set<SessionDb>();
const runtimes = new Set<SkillRuntime>();
const guidance = 'KERNEL_CONTINUITY_CHECK then KERNEL_CONTINUITY_VERIFY.';
const reference = 'PINNED_KERNEL_REFERENCE';
const name = 'learned-kernel-check';
const latest: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Continue the check.' }],
};

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.clear();
  for (const db of databases) db.close();
  databases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openDb(path: string): SessionDb {
  const db = SessionDb.open({ path });
  databases.add(db);
  return db;
}

function closeDb(db: SessionDb): void {
  db.close();
  databases.delete(db);
}

function mockProvider(attemptRead = false) {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'kernel-continuity-fixture',
    async *stream(request) {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      yield { type: 'message_start' };
      const useTool = attemptRead && requests.length === 1;
      const message: AssistantMessage = {
        role: 'assistant',
        content: useTool
          ? [{ type: 'tool_use', id: 'resumed-read', name: 'Read', input: {} }]
          : [{ type: 'text', text: 'Check complete.' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: useTool ? 'tool_use' : 'end_turn' };
      return message;
    },
  };
  return { provider, requests };
}

async function drain(generator: ReturnType<typeof query>) {
  for (;;) {
    const step = await generator.next();
    if (step.done) return step.value;
  }
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kernel-linked-continuity-')));
  roots.push(root);
  const cwd = join(root, 'node');
  const harnessHome = join(root, 'profile');
  const storage = join(root, 'approved-skills');
  const skillDir = join(storage, name);
  const referenceRoot = join(root, 'separate-reference-root');
  mkdirSync(join(cwd, '.agents/skills'), { recursive: true });
  mkdirSync(join(cwd, '.git'));
  mkdirSync(harnessHome);
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(referenceRoot);
  writeFileSync(join(referenceRoot, 'check.md'), reference);
  symlinkSync(join(referenceRoot, 'check.md'), join(skillDir, 'check.md'));
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Synthetic learned Kernel check\ncontext: kernel\nversion: 3\ntier: kernel\nharnesses: [sov, codex]\nallowedTools: [Read, Bash]\nx-kernel: {kind: learned, inert: {tool_grant: Write}}\n---\n${guidance}\nActivation result: !\`fixture-check\``,
  );
  symlinkSync(skillDir, join(cwd, '.agents/skills', name), 'dir');
  const runtime = async (approveReference = false) => {
    const host = createSkillRuntime({
      discovery: { cwd, harnessHome, allowedLinkRoots: [storage] },
      ...(approveReference ? { allowedResourceRoots: async () => [skillDir, referenceRoot] } : {}),
    });
    runtimes.add(host);
    await host.discover();
    return host;
  };
  return { root, cwd, harnessHome, runtime, dbPath: join(root, 'sessions.db') };
}

function countingTools() {
  const calls = { Read: 0, Write: 0, Bash: 0 };
  const tools = (['Read', 'Write', 'Bash'] as const).map((toolName) =>
    buildTool<unknown, unknown>({
      name: toolName,
      description: () => `Synthetic ${toolName}`,
      inputSchema: z.unknown(),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        calls[toolName]++;
        return { data: toolName === 'Bash' ? { stdout: 'ACTIVATION_ONCE', exit_code: 0 } : 'ok' };
      },
    }),
  );
  return { tools, calls };
}

describe('linked Kernel guidance through native SOV persistence and turns', () => {
  test('database reopen delivers guidance, while fresh host policy and resource roots govern', async () => {
    const f = await fixture();
    const firstHost = await f.runtime(true);
    let db = openDb(f.dbPath);
    const sessionId = db.createSession({ provider: 'mock', model: 'mock', owner: 'alice' });
    let continuity = buildSovSkillContinuity({ db, harnessHome: f.harnessHome, sessionId });
    const { tools, calls } = countingTools();
    const state = createSkillActivationState({
      tools,
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const firstContext = firstHost.bindContext({
      cwd: f.cwd,
      sessionId,
      skillContinuity: continuity,
      skillActivation: state,
    });
    const activated = await firstHost.activate(name, {
      source: 'user',
      toolContext: firstContext,
      state,
    });
    expect(activated.prompt).toContain(guidance);
    expect(calls.Bash).toBe(1);
    expect(state.tools.map((tool) => tool.name)).toEqual(['Read', 'Bash']);
    expect((await SkillsViewTool.call({ name, path: 'check.md' }, firstContext)).data.content).toBe(
      reference,
    );
    const first = mockProvider();
    expect(
      (
        await drain(
          query({
            provider: first.provider,
            model: 'mock',
            messages: [latest],
            systemPrompt: [],
            tools,
            maxTokens: 128,
            toolContext: firstContext,
          }),
        )
      ).reason,
    ).toBe('completed');
    expect(first.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['Read', 'Bash']);
    const records = await continuity.exportRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe('succeeded');
    expect(records[0]?.revision).toBe(activated.activation.revision);
    expect(records[0]).not.toHaveProperty('allowedTools');
    expect(records[0]).not.toHaveProperty('allowedResourceRoots');
    expect(db.getSession(sessionId)?.metadata).toEqual({});
    expect(JSON.stringify(db.listSessions())).not.toContain(guidance);
    firstHost.dispose();
    runtimes.delete(firstHost);
    closeDb(db);

    // A new host, context and real database connection model a resumed CLI turn.
    db = openDb(f.dbPath);
    const secondHost = await f.runtime();
    continuity = buildSovSkillContinuity({ db, harnessHome: f.harnessHome, sessionId });
    const freshTools = tools.filter((tool) => tool.name !== 'Bash');
    let denials = 0;
    const freshState = createSkillActivationState({
      tools: freshTools,
      canUseTool: async () => {
        denials++;
        return { behavior: 'deny', reason: 'Current host refuses this read' };
      },
    });
    const resumedContext = secondHost.bindContext({
      cwd: f.cwd,
      sessionId,
      skillContinuity: continuity,
      skillActivation: freshState,
    });
    expect(freshState.turnId).not.toBe(state.turnId);
    expect(freshState.activations).toEqual([]);
    const resumed = mockProvider(true);
    expect(
      (
        await drain(
          query({
            provider: resumed.provider,
            model: 'mock',
            messages: [latest],
            systemPrompt: [],
            tools: freshTools,
            maxTokens: 128,
            toolContext: resumedContext,
          }),
        )
      ).reason,
    ).toBe('completed');
    expect(resumed.requests).toHaveLength(2);
    expect(resumed.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['Read', 'Write']);
    const received = JSON.stringify(resumed.requests[0]?.messages);
    expect(received).toContain(guidance);
    expect(received).toContain(reference);
    expect(received).toContain(activated.activation.revision);
    expect(JSON.stringify(resumed.requests[0]?.system)).not.toContain(guidance);
    expect(JSON.stringify(resumed.requests[1]?.messages)).toContain(
      'Current host refuses this read',
    );
    expect(denials).toBe(1);
    expect(calls).toEqual({ Read: 0, Write: 0, Bash: 1 });
    expect(freshState.activations).toEqual([]);
    await expect(SkillsViewTool.call({ name, path: 'check.md' }, resumedContext)).rejects.toThrow(
      'escapes',
    );

    const independent = db.createSession({ provider: 'mock', model: 'mock', owner: 'alice' });
    const otherOwner = db.createSession({ provider: 'mock', model: 'mock', owner: 'bob' });
    for (const [isolatedSession, profile] of [
      [independent, f.harnessHome],
      [otherOwner, f.harnessHome],
      [sessionId, join(f.root, 'different-profile')],
    ] as const) {
      const isolated = mockProvider();
      const port = buildSovSkillContinuity({
        db,
        harnessHome: profile,
        sessionId: isolatedSession,
      });
      expect(
        (
          await drain(
            query({
              provider: isolated.provider,
              model: 'mock',
              messages: [latest],
              systemPrompt: [],
              tools: freshTools,
              maxTokens: 128,
              toolContext: secondHost.bindContext({
                cwd: f.cwd,
                sessionId: isolatedSession,
                skillContinuity: port,
              }),
            }),
          )
        ).reason,
      ).toBe('completed');
      expect(isolated.requests).toHaveLength(1);
      expect(JSON.stringify(isolated.requests[0]?.messages)).not.toContain(guidance);
      expect(JSON.stringify(isolated.requests[0]?.messages)).not.toContain(reference);
      expect(await port.exportRecords()).toEqual([]);
    }
    const profile = skillContinuityProfileKey(f.harnessHome);
    await expect(
      new SessionSkillContinuityStore(db, profile).load({
        profile,
        owner: 'user:bob',
        session: sessionId,
      }),
    ).rejects.toThrow('unavailable');
    expect((await continuity.exportRecords())[0]?.guidance).toContain(guidance);
  });

  test('turn-only linked activation expires through query completion before database reopen', async () => {
    const f = await fixture();
    const host = await f.runtime();
    let db = openDb(f.dbPath);
    const sessionId = db.createSession({ provider: 'mock', model: 'mock', owner: 'alice' });
    const profile = skillContinuityProfileKey(f.harnessHome);
    const continuity = createSkillContinuity({
      scope: { profile, owner: 'user:alice', session: sessionId },
      store: new SessionSkillContinuityStore(db, profile),
      lifetime: 'turn',
    });
    const { tools, calls } = countingTools();
    const state = createSkillActivationState({
      tools,
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const context: ToolContext = host.bindContext({
      cwd: f.cwd,
      sessionId,
      skillActivation: state,
      skillContinuity: continuity,
    });
    await host.activate(name, { source: 'user', toolContext: context, state });
    expect((await continuity.exportRecords())[0]?.lifetime).toBe('turn');
    const first = mockProvider();
    expect(
      (
        await drain(
          query({
            provider: first.provider,
            model: 'mock',
            messages: [latest],
            systemPrompt: [],
            tools,
            maxTokens: 128,
            toolContext: context,
          }),
        )
      ).reason,
    ).toBe('completed');
    expect(JSON.stringify(first.requests[0]?.messages)).toContain(guidance);
    expect(await continuity.exportRecords()).toEqual([]);
    host.dispose();
    runtimes.delete(host);
    closeDb(db);

    db = openDb(f.dbPath);
    const resumedHost = await f.runtime();
    const resumed = mockProvider();
    const resumedPort = buildSovSkillContinuity({ db, harnessHome: f.harnessHome, sessionId });
    expect(
      (
        await drain(
          query({
            provider: resumed.provider,
            model: 'mock',
            messages: [latest],
            systemPrompt: [],
            tools: [],
            maxTokens: 128,
            toolContext: resumedHost.bindContext({
              cwd: f.cwd,
              sessionId,
              skillContinuity: resumedPort,
            }),
          }),
        )
      ).reason,
    ).toBe('completed');
    expect(resumed.requests).toHaveLength(1);
    expect(JSON.stringify(resumed.requests[0]?.messages)).not.toContain(guidance);
    expect(await resumedPort.exportRecords()).toEqual([]);
    expect(calls.Bash).toBe(1);
  });
});
