// T4 (config live-apply, 2026-06-14) — net-new hook + catalog coverage tests.
//
// Covers the hooks added/extended in this slice against a mock CommandContext:
//   - defaultModel + providers.<x>.model cross-family vs same-family verdicts
//     (setModel vs reresolveProvider, degrade-to-persisted-only contract);
//   - defaultProvider / providers.<x>.{apiKey,baseUrl} → reresolveProvider;
//   - router.* lane fields → reresolveProvider; maxConcurrent* stay hookless;
//   - learning recall/synthesis fields → rebuildRecall; tunables → live sentinel;
//     prune/crossProject/observationBufferSize stay hookless;
//   - ui.* render-flag side-effects (M6) + permissionMode side-effect;
//   - ui.theme routed through the theme hook;
//   - listUnmanagedKeys recursion into partially-catalogued blocks;
//   - the new orphan catalog fields are present + findable.

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '@yevgetman/sov-sdk/commands/types';
import type { Settings } from '@yevgetman/sov-sdk/config/schema';
import { findGroup, findItem, listUnmanagedKeys } from '../../src/config/catalog.js';
import {
  LIVE_APPLY_HOOKS,
  type LiveApplyHook,
  type LiveApplySideEffect,
} from '../../src/config/liveApply.js';
import { makeCtx } from '../commands/_makeCtx.js';

/** Guarded accessor — LIVE_APPLY_HOOKS indexes to `LiveApplyHook | undefined`
 *  under noUncheckedIndexedAccess; throw loudly (not silently no-op) when a
 *  hook the test expects is missing. */
function H(key: string): LiveApplyHook {
  const hook = LIVE_APPLY_HOOKS[key];
  if (hook === undefined) throw new Error(`no live-apply hook registered for: ${key}`);
  return hook;
}

type ReresolveCall = { provider: string | undefined; model: string | undefined };

function makeReresolveCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  reresolveCalls: ReresolveCall[];
} {
  const reresolveCalls: ReresolveCall[] = [];
  const ctx = makeCtx({
    reresolveProvider: async (provider?: string, model?: string) => {
      reresolveCalls.push({ provider, model });
    },
    ...overrides,
  });
  return { ctx, reresolveCalls };
}

function captureSideEffects(): {
  recorded: LiveApplySideEffect[];
  recordSideEffect: (effect: LiveApplySideEffect) => void;
} {
  const recorded: LiveApplySideEffect[] = [];
  return { recorded, recordSideEffect: (effect) => recorded.push(effect) };
}

describe('T4 — defaultModel cross-family vs same-family', () => {
  test('same-family change calls setModel and returns applied (no reresolve)', async () => {
    const { ctx, reresolveCalls } = makeReresolveCtx({ providerName: 'anthropic' });
    const calls: string[] = [];
    ctx.setModel = (m) => calls.push(m);
    const verdict = await H('defaultModel')('claude-opus-4-7', { commandCtx: ctx });
    expect(verdict).toBe('applied');
    expect(calls).toEqual(['claude-opus-4-7']);
    expect(reresolveCalls).toEqual([]);
  });

  test('cross-family change calls reresolveProvider with the new model and returns applied', async () => {
    const { ctx, reresolveCalls } = makeReresolveCtx({ providerName: 'anthropic' });
    const verdict = await H('defaultModel')('gpt-4o', { commandCtx: ctx });
    expect(verdict).toBe('applied');
    expect(reresolveCalls).toEqual([{ provider: undefined, model: 'gpt-4o' }]);
  });

  test('cross-family change degrades to persisted-only when reresolveProvider absent', async () => {
    const ctx = makeCtx({ providerName: 'anthropic' }); // no reresolveProvider
    const verdict = await H('defaultModel')('gpt-4o', { commandCtx: ctx });
    expect(verdict).toBe('persisted-only');
  });

  test('returns persisted-only when commandCtx is undefined', async () => {
    const verdict = await H('defaultModel')('gpt-4o', {});
    expect(verdict).toBe('persisted-only');
  });
});

describe('T4 — providers.<x>.model active/non-active/cross-family', () => {
  test('active provider, same family → setModel + applied', async () => {
    const { ctx, reresolveCalls } = makeReresolveCtx({ providerName: 'anthropic' });
    const calls: string[] = [];
    ctx.setModel = (m) => calls.push(m);
    const verdict = await H('providers.anthropic.model')('claude-sonnet-4-6', {
      commandCtx: ctx,
    });
    expect(verdict).toBe('applied');
    expect(calls).toEqual(['claude-sonnet-4-6']);
    expect(reresolveCalls).toEqual([]);
  });

  test('active provider, cross family → reresolveProvider(provider, model) + applied', async () => {
    const { ctx, reresolveCalls } = makeReresolveCtx({ providerName: 'openai' });
    // openai is active (apiMode anthropic in the stub, so a gpt id is "cross"
    // relative to apiMode); use an explicitly cross id to exercise the branch.
    const verdict = await H('providers.openai.model')('o3-custom', {
      commandCtx: ctx,
    });
    expect(verdict).toBe('applied');
    expect(reresolveCalls).toEqual([{ provider: 'openai', model: 'o3-custom' }]);
  });

  test('non-active provider → applied (future default, no setModel/reresolve)', async () => {
    const { ctx, reresolveCalls } = makeReresolveCtx({ providerName: 'anthropic' });
    const calls: string[] = [];
    ctx.setModel = (m) => calls.push(m);
    const verdict = await H('providers.openai.model')('gpt-4o', {
      commandCtx: ctx,
    });
    expect(verdict).toBe('applied'); // green is honest — applies on provider switch
    expect(calls).toEqual([]);
    expect(reresolveCalls).toEqual([]);
  });

  test('providers.sov.model hook exists', () => {
    expect(LIVE_APPLY_HOOKS['providers.sov.model']).toBeDefined();
  });
});

describe('T4 — defaultProvider + credential/endpoint reresolve hooks', () => {
  const KEYS = [
    'defaultProvider',
    'providers.anthropic.apiKey',
    'providers.openai.apiKey',
    'providers.openai.baseUrl',
    'providers.openrouter.apiKey',
    'providers.ollama.baseUrl',
    'providers.ollama.numCtx',
    'providers.sov.baseUrl',
  ];

  for (const key of KEYS) {
    test(`${key} → reresolveProvider + applied`, async () => {
      const { ctx, reresolveCalls } = makeReresolveCtx();
      const hook = LIVE_APPLY_HOOKS[key];
      expect(hook, `${key} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook('value', { commandCtx: ctx });
      expect(verdict).toBe('applied');
      expect(reresolveCalls.length).toBe(1);
    });

    test(`${key} → persisted-only when reresolveProvider absent`, async () => {
      const ctx = makeCtx();
      const hook = LIVE_APPLY_HOOKS[key];
      if (!hook) return;
      const verdict = await hook('value', { commandCtx: ctx });
      expect(verdict).toBe('persisted-only');
    });
  }
});

describe('T4 — router lane hooks (and maxConcurrent stays hookless)', () => {
  const LANE_KEYS = [
    'router.defaultLane',
    'router.localProvider',
    'router.localModel',
    'router.frontierProvider',
    'router.frontierModel',
    'router.escalationMode',
  ];

  for (const key of LANE_KEYS) {
    test(`${key} → reresolveProvider + applied`, async () => {
      const { ctx, reresolveCalls } = makeReresolveCtx();
      const hook = LIVE_APPLY_HOOKS[key];
      expect(hook, `${key} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook('local', { commandCtx: ctx });
      expect(verdict).toBe('applied');
      expect(reresolveCalls.length).toBe(1);
    });
  }

  test('router.maxConcurrentLocal/Frontier have NO hook (LaneSemaphores no resize API)', () => {
    expect(LIVE_APPLY_HOOKS['router.maxConcurrentLocal']).toBeUndefined();
    expect(LIVE_APPLY_HOOKS['router.maxConcurrentFrontier']).toBeUndefined();
  });
});

describe('T4 — learning recall/synthesis hooks → rebuildRecall', () => {
  const RECALL_KEYS = [
    'learning.disabled',
    'learning.synthesizerEveryN',
    'learning.synthesizerEveryNToolIterations',
    'learning.recall.enabled',
    'learning.recall.maxLessons',
    'learning.recall.tokenBudget',
  ];

  for (const key of RECALL_KEYS) {
    test(`${key} → rebuildRecall + applied`, async () => {
      let called = 0;
      const ctx = makeCtx({
        rebuildRecall: async () => {
          called += 1;
        },
      });
      const hook = LIVE_APPLY_HOOKS[key];
      expect(hook, `${key} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook(true, { commandCtx: ctx });
      expect(verdict).toBe('applied');
      expect(called).toBe(1);
    });

    test(`${key} → persisted-only when rebuildRecall absent`, async () => {
      const ctx = makeCtx();
      const hook = LIVE_APPLY_HOOKS[key];
      if (!hook) return;
      const verdict = await hook(true, { commandCtx: ctx });
      expect(verdict).toBe('persisted-only');
    });
  }
});

describe('T4 — learning confidence tunables → read-on-demand sentinel', () => {
  const TUNING_KEYS = [
    'learning.reinforcementCurveK',
    'learning.evidenceSaturation',
    'learning.contradictionDelta',
    'learning.confidenceCap',
    'learning.initialConfidenceBaseline',
  ];

  for (const key of TUNING_KEYS) {
    test(`${key} → applied (no rebuild needed; loadConfidenceTuning re-reads disk)`, async () => {
      const ctx = makeCtx(); // no rebuildRecall — tunables don't need it
      const hook = LIVE_APPLY_HOOKS[key];
      expect(hook, `${key} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook(0.5, { commandCtx: ctx });
      expect(verdict).toBe('applied');
    });

    test(`${key} → persisted-only when commandCtx undefined`, async () => {
      const hook = LIVE_APPLY_HOOKS[key];
      if (!hook) return;
      const verdict = await hook(0.5, {});
      expect(verdict).toBe('persisted-only');
    });
  }

  test('prune/crossProject/observationBufferSize stay hookless (not in-session)', () => {
    expect(LIVE_APPLY_HOOKS['learning.pruneBelowConfidence']).toBeUndefined();
    expect(LIVE_APPLY_HOOKS['learning.pruneAgeDays']).toBeUndefined();
    expect(LIVE_APPLY_HOOKS['learning.crossProjectMinConfidence']).toBeUndefined();
    expect(LIVE_APPLY_HOOKS['learning.observationBufferSize']).toBeUndefined();
  });
});

describe('T4 — ui.* render-flag side-effects (M6)', () => {
  test('ui.footer.enabled records footerChanged', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    const verdict = await H('ui.footer.enabled')(false, {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(cap.recorded[0]).toEqual({ footerChanged: false });
  });

  test('ui.diffRender.enabled records diffRenderChanged', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    await H('ui.diffRender.enabled')(true, {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(cap.recorded[0]).toEqual({ diffRenderChanged: true });
  });

  test('ui.toolOutput.mode records toolOutputChanged.mode', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    await H('ui.toolOutput.mode')('detailed', {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(cap.recorded[0]).toEqual({ toolOutputChanged: { mode: 'detailed' } });
  });

  test('ui.toolOutput.inlineLines records toolOutputChanged.inlineLines', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    await H('ui.toolOutput.inlineLines')(20, {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(cap.recorded[0]).toEqual({ toolOutputChanged: { inlineLines: 20 } });
  });

  test('ui.contextMeter.warnAtPercent records contextMeterChanged.warnAtPercent', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    await H('ui.contextMeter.warnAtPercent')(70, {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(cap.recorded[0]).toEqual({ contextMeterChanged: { warnAtPercent: 70 } });
  });

  test('ui.contextMeter.dangerAtPercent records contextMeterChanged.dangerAtPercent', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    await H('ui.contextMeter.dangerAtPercent')(90, {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(cap.recorded[0]).toEqual({ contextMeterChanged: { dangerAtPercent: 90 } });
  });

  test('ui.theme routes through the theme hook (records themeChanged)', async () => {
    const ctx = makeCtx();
    const cap = captureSideEffects();
    const verdict = await H('ui.theme')('light', {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(cap.recorded[0]).toEqual({ themeChanged: 'light' });
  });

  test('every ui.* hook returns persisted-only when commandCtx undefined', async () => {
    const keys = [
      'ui.footer.enabled',
      'ui.diffRender.enabled',
      'ui.toolOutput.mode',
      'ui.toolOutput.inlineLines',
      'ui.contextMeter.warnAtPercent',
      'ui.contextMeter.dangerAtPercent',
    ];
    for (const key of keys) {
      const verdict = await H(key)('v', {});
      expect(verdict).toBe('persisted-only');
    }
  });
});

describe('T4 — permissionMode records permissionModeChanged', () => {
  test('records permissionModeChanged with the new mode', async () => {
    const cap = captureSideEffects();
    const ctx = makeCtx({ setPermissionMode: () => {} });
    const verdict = await H('permissionMode')('bypass', {
      commandCtx: ctx,
      recordSideEffect: cap.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(cap.recorded[0]).toEqual({ permissionModeChanged: 'bypass' });
  });
});

describe('T4 — listUnmanagedKeys recursion', () => {
  test('recurses into a partially-catalogued block and surfaces only orphan sub-fields', () => {
    // gateway.token/port/host + the four new numeric fields are catalogued;
    // gateway.corsOrigins + gateway.principals are NOT → must surface as
    // dotted sub-paths, not hide behind the catalogued siblings.
    const settings = {
      gateway: {
        token: 'secret', // catalogued — managed
        corsOrigins: ['https://x'], // orphan
        principals: [{ id: 'a', token: 't' }], // orphan
      },
    } as unknown as Settings;
    const unmanaged = listUnmanagedKeys(settings);
    expect(unmanaged).toContain('gateway.corsOrigins');
    expect(unmanaged).toContain('gateway.principals');
    expect(unmanaged).not.toContain('gateway');
    expect(unmanaged).not.toContain('gateway.token');
  });

  test('a wholly-uncatalogued top-level key is reported as itself (not recursed)', () => {
    const settings = {
      defaultProvider: 'anthropic', // catalogued
      futureExp: { something: 'experimental', nested: { deep: 1 } },
    } as unknown as Settings;
    const unmanaged = listUnmanagedKeys(settings);
    expect(unmanaged).toContain('futureExp');
    expect(unmanaged).not.toContain('futureExp.something');
    expect(unmanaged).not.toContain('defaultProvider');
  });

  test('empty settings → no orphans', () => {
    expect(listUnmanagedKeys({} as Settings)).toEqual([]);
  });

  test('fully-catalogued block surfaces nothing', () => {
    const settings = {
      providers: { anthropic: { model: 'claude-sonnet-4-6' } },
    } as unknown as Settings;
    expect(listUnmanagedKeys(settings)).toEqual([]);
  });
});

describe('T4 — orphan catalog fields are present', () => {
  test('learning.recall.* fields are findable in the learning group', () => {
    for (const path of [
      'learning.recall.enabled',
      'learning.recall.maxLessons',
      'learning.recall.tokenBudget',
    ]) {
      const item = findItem(path);
      expect(item, `${path} should be catalogued`).toBeDefined();
    }
  });

  test('providers-sov subgroup exists with model + baseUrl and is a drill-in target', () => {
    const group = findGroup('providers-sov');
    expect(group).toBeDefined();
    const paths = (group?.items ?? []).map((i) => i.path);
    expect(paths).toEqual(['providers.sov.model', 'providers.sov.baseUrl']);
    const providers = findGroup('providers');
    const targets = providers?.drillInto?.map((d) => d.targetGroupId) ?? [];
    expect(targets).toContain('providers-sov');
  });

  test('the missing gateway.* fields are now catalogued', () => {
    for (const path of [
      'gateway.eventBufferSize',
      'gateway.idleSessionTimeoutMs',
      'gateway.idleSweepIntervalMs',
      'gateway.maxConcurrentSessions',
    ]) {
      const item = findItem(path);
      expect(item, `${path} should be catalogued`).toBeDefined();
    }
  });
});
