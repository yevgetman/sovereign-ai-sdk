// canUseTool decider tests — fake tools + scripted asker so we cover every
// branch (bypass, rule matching, always-cache, self-check passthrough,
// ask→allow/always/deny).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildCanUseTool } from '../../src/permissions/canUseTool.js';
import type { AskResponse, AskUser, PermissionResult } from '../../src/permissions/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import { BashTool } from '../../src/tools/BashTool.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};
const bashTool = BashTool as unknown as Tool<unknown, unknown>;

function makeTool(checkPermissions?: () => Promise<PermissionResult>): Tool<unknown, unknown> {
  const def: Parameters<typeof buildTool>[0] = {
    name: 'Probe',
    description: () => 'probe',
    inputSchema: z.object({ note: z.string().optional() }),
    async call() {
      return { data: 'ok' };
    },
  };
  if (checkPermissions) def.checkPermissions = checkPermissions;
  return buildTool(def) as unknown as Tool<unknown, unknown>;
}

function makePathTool(checkPermissions?: () => Promise<PermissionResult>): Tool<unknown, unknown> {
  const inputSchema = z.object({ path: z.string() });
  const def: Parameters<typeof buildTool<z.infer<typeof inputSchema>, string>>[0] = {
    name: 'FileWrite',
    aliases: ['Write'],
    description: () => 'write',
    inputSchema,
    preparePermissionMatcher: async (input) => (pattern) =>
      pattern === '*' ||
      pattern === input.path ||
      (pattern === '*.txt' && input.path.endsWith('.txt')),
    async call() {
      return { data: 'ok' };
    },
  };
  if (checkPermissions) def.checkPermissions = checkPermissions;
  return buildTool(def) as unknown as Tool<unknown, unknown>;
}

function scriptAsker(queue: AskResponse[]): { ask: AskUser; calls: number } {
  let i = 0;
  let calls = 0;
  const ask: AskUser = async () => {
    calls = ++i;
    const next = queue.shift();
    if (next === undefined) throw new Error('ask called beyond scripted queue');
    return next;
  };
  return {
    ask,
    get calls() {
      return calls;
    },
  };
}

describe('buildCanUseTool', () => {
  test('bypass mode allows without consulting tool or asker', async () => {
    let selfCheckCalled = false;
    const tool = makeTool(async () => {
      selfCheckCalled = true;
      return { behavior: 'deny' };
    });
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'bypass',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(selfCheckCalled).toBe(false);
    expect(asker.calls).toBe(0);
  });

  test('deny rule blocks even in bypass mode', async () => {
    let selfCheckCalled = false;
    const tool = makePathTool(async () => {
      selfCheckCalled = true;
      return { behavior: 'allow' };
    });
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'bypass',
      ask: asker.ask,
      alwaysAllow: new Set(),
      ruleLayers: [
        {
          source: 'project',
          rules: [{ behavior: 'deny', tool: 'Write', content: '*.txt', raw: 'Write(*.txt)' }],
        },
      ],
    });
    const result = await canUseTool(tool, { path: 'blocked.txt' }, ctx);
    expect(result.behavior).toBe('deny');
    expect(result.reason).toContain('Write(*.txt)');
    expect(selfCheckCalled).toBe(false);
    expect(asker.calls).toBe(0);
  });

  test('higher-precedence layer can allow over a lower-precedence deny', async () => {
    const tool = makePathTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
      ruleLayers: [
        {
          source: 'local',
          rules: [{ behavior: 'allow', tool: 'Write', content: 'ok.txt', raw: 'Write(ok.txt)' }],
        },
        {
          source: 'user',
          rules: [{ behavior: 'deny', tool: 'Write', content: '*.txt', raw: 'Write(*.txt)' }],
        },
      ],
    });
    const result = await canUseTool(tool, { path: 'ok.txt' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(asker.calls).toBe(0);
  });

  test('ask rule forces a prompt even when the tool self-check allows', async () => {
    const tool = makePathTool(async () => ({ behavior: 'allow' }));
    const asker = scriptAsker(['deny']);
    const canUseTool = buildCanUseTool({
      mode: 'default',
      ask: asker.ask,
      alwaysAllow: new Set(),
      ruleLayers: [
        {
          source: 'project',
          rules: [
            { behavior: 'ask', tool: 'Write', content: 'review.txt', raw: 'Write(review.txt)' },
          ],
        },
      ],
    });
    const result = await canUseTool(tool, { path: 'review.txt' }, ctx);
    expect(result.behavior).toBe('deny');
    expect(asker.calls).toBe(1);
  });

  test('always-cache short-circuits both self-check and asker', async () => {
    let selfCheckCalled = false;
    const tool = makeTool(async () => {
      selfCheckCalled = true;
      return { behavior: 'ask' };
    });
    const asker = scriptAsker([]);
    const cache = new Set(['Probe']);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: cache,
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(selfCheckCalled).toBe(false);
    expect(asker.calls).toBe(0);
  });

  test("self-check 'allow' returns allow without prompting", async () => {
    const tool = makeTool(async () => ({ behavior: 'allow', reason: 'preapproved' }));
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(result.reason).toBe('preapproved');
    expect(asker.calls).toBe(0);
  });

  test('ask mode allows read-only Bash self-checks without prompting', async () => {
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(bashTool, { command: 'pwd && ls' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(asker.calls).toBe(0);
  });

  test('explicit ask rules still force prompts for read-only Bash', async () => {
    const asker = scriptAsker(['deny']);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
      ruleLayers: [
        {
          source: 'project',
          rules: [{ behavior: 'ask', tool: 'Bash', content: '*', raw: 'Bash(*)' }],
        },
      ],
    });
    const result = await canUseTool(bashTool, { command: 'pwd && ls' }, ctx);
    expect(result.behavior).toBe('deny');
    expect(asker.calls).toBe(1);
  });

  test("self-check 'deny' returns deny without prompting", async () => {
    const tool = makeTool(async () => ({ behavior: 'deny', reason: 'policy' }));
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('deny');
    expect(result.reason).toBe('policy');
    expect(asker.calls).toBe(0);
  });

  test("self-check 'ask' + user says allow → allow", async () => {
    const tool = makeTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['allow']);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(asker.calls).toBe(1);
  });

  test("self-check 'ask' + user says deny → deny with user-denied reason", async () => {
    const tool = makeTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['deny']);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('deny');
    expect(result.reason).toBe('user denied');
  });

  test("self-check 'ask' + user says always → allow AND tool added to cache", async () => {
    const tool = makePathTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['always']);
    const cache = new Set<string>();
    const persisted: string[] = [];
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: cache,
      recordAlwaysAllow: (rule) => {
        persisted.push(rule);
      },
    });
    const result = await canUseTool(tool, { path: 'always.txt' }, ctx);
    expect(result.behavior).toBe('allow');
    expect(cache.has('FileWrite(always.txt)')).toBe(true);
    expect(persisted).toEqual(['FileWrite(always.txt)']);
  });

  test('second call after always skips the asker', async () => {
    const tool = makePathTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['always']);
    const cache = new Set<string>();
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: cache,
    });
    await canUseTool(tool, { path: 'same.txt' }, ctx);
    const second = await canUseTool(tool, { path: 'same.txt' }, ctx);
    expect(second.behavior).toBe('allow');
    expect(asker.calls).toBe(1);
  });

  test('default checkPermissions (from buildTool defaults) is allow', async () => {
    const tool = makeTool(); // no checkPermissions override — factory default applies
    const asker = scriptAsker([]);
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: new Set(),
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(asker.calls).toBe(0);
  });
});
