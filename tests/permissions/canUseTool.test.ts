// canUseTool decider tests — fake tools + scripted asker so we cover every
// branch (bypass, always-cache, self-check passthrough, ask→allow/always/deny).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildCanUseTool } from '../../src/permissions/canUseTool.js';
import type { AskResponse, AskUser, PermissionResult } from '../../src/permissions/types.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

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
    const tool = makeTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['always']);
    const cache = new Set<string>();
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: cache,
    });
    const result = await canUseTool(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
    expect(cache.has('Probe')).toBe(true);
  });

  test('second call after always skips the asker', async () => {
    const tool = makeTool(async () => ({ behavior: 'ask' }));
    const asker = scriptAsker(['always']);
    const cache = new Set<string>();
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask: asker.ask,
      alwaysAllow: cache,
    });
    await canUseTool(tool, { note: 'first' }, ctx);
    const second = await canUseTool(tool, { note: 'second' }, ctx);
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
