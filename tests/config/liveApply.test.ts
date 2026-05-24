// Tests each of the v0 live-apply hooks (src/config/liveApply.ts):
// theme, defaultModel, providers.<x>.model (4 variants), verbose,
// webSearch.{provider,apiKey,maxResults}. Each hook is exercised for:
//   (a) when commandCtx is undefined (sov config standalone) → returns
//       'persisted-only' and emits NO side-effects;
//   (b) when commandCtx is defined → performs the appropriate action;
//   (c) for providers.<x>.model — the conditional-on-active-provider
//       branch fires 'applied' only when ctx.providerName matches.

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../src/commands/types.js';
import { LIVE_APPLY_HOOKS, type LiveApplySideEffect } from '../../src/config/liveApply.js';
import { makeCtx } from '../commands/_makeCtx.js';

type SideEffectCapture = {
  recorded: LiveApplySideEffect[];
  recordSideEffect: (effect: LiveApplySideEffect) => void;
};

function captureSideEffects(): SideEffectCapture {
  const recorded: LiveApplySideEffect[] = [];
  return {
    recorded,
    recordSideEffect: (effect) => {
      recorded.push(effect);
    },
  };
}

function setModelCapture(ctx: CommandContext): { calls: string[] } {
  const calls: string[] = [];
  const original = ctx.setModel;
  ctx.setModel = (m: string) => {
    calls.push(m);
    original(m);
  };
  return { calls };
}

describe('LIVE_APPLY_HOOKS — theme', () => {
  test('returns applied when commandCtx is defined; records themeChanged', async () => {
    const ctx = makeCtx();
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.theme;
    expect(hook).toBeDefined();
    if (!hook) return;
    const verdict = await hook('light', {
      commandCtx: ctx,
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(capture.recorded.length).toBe(1);
    expect(capture.recorded[0]).toEqual({ themeChanged: 'light' });
  });

  test('returns persisted-only when commandCtx is undefined; emits no side-effects', async () => {
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.theme;
    if (!hook) return;
    const verdict = await hook('light', {
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('persisted-only');
    expect(capture.recorded.length).toBe(0);
  });

  test('unknown theme name returns persisted-only', async () => {
    const ctx = makeCtx();
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.theme;
    if (!hook) return;
    const verdict = await hook('a-theme-that-does-not-exist', {
      commandCtx: ctx,
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('persisted-only');
  });

  test('undefined newValue (unset) recovers default theme and records themeChanged', async () => {
    const ctx = makeCtx();
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.theme;
    if (!hook) return;
    const verdict = await hook(undefined, {
      commandCtx: ctx,
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(capture.recorded[0]).toEqual({ themeChanged: 'dark' });
  });
});

describe('LIVE_APPLY_HOOKS — defaultModel', () => {
  test('returns applied and calls setModel when commandCtx is defined', async () => {
    const ctx = makeCtx();
    const tracker = setModelCapture(ctx);
    const hook = LIVE_APPLY_HOOKS.defaultModel;
    if (!hook) return;
    const verdict = await hook('claude-opus-4-7', { commandCtx: ctx });
    expect(verdict).toBe('applied');
    expect(tracker.calls).toEqual(['claude-opus-4-7']);
  });

  test('returns persisted-only when commandCtx is undefined; no setModel call', async () => {
    const hook = LIVE_APPLY_HOOKS.defaultModel;
    if (!hook) return;
    const verdict = await hook('claude-opus-4-7', {});
    expect(verdict).toBe('persisted-only');
  });

  test('undefined newValue (unset) returns persisted-only and does NOT call setModel', async () => {
    const ctx = makeCtx();
    const tracker = setModelCapture(ctx);
    const hook = LIVE_APPLY_HOOKS.defaultModel;
    if (!hook) return;
    const verdict = await hook(undefined, { commandCtx: ctx });
    expect(verdict).toBe('persisted-only');
    expect(tracker.calls).toEqual([]);
  });
});

describe('LIVE_APPLY_HOOKS — providers.<x>.model conditional', () => {
  const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama'] as const;

  for (const providerName of PROVIDERS) {
    const hookKey = `providers.${providerName}.model`;

    test(`${hookKey} — fires applied when ctx.providerName matches`, async () => {
      const ctx = makeCtx({ providerName });
      const tracker = setModelCapture(ctx);
      const hook = LIVE_APPLY_HOOKS[hookKey];
      expect(hook, `${hookKey} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook('my-new-model', { commandCtx: ctx });
      expect(verdict).toBe('applied');
      expect(tracker.calls).toEqual(['my-new-model']);
    });

    test(`${hookKey} — returns persisted-only when ctx.providerName does NOT match`, async () => {
      // Pick a different provider than the one being tested.
      const wrongProvider = PROVIDERS.find((p) => p !== providerName);
      expect(wrongProvider).toBeDefined();
      if (!wrongProvider) return;
      const ctx = makeCtx({ providerName: wrongProvider });
      const tracker = setModelCapture(ctx);
      const hook = LIVE_APPLY_HOOKS[hookKey];
      if (!hook) return;
      const verdict = await hook('my-new-model', { commandCtx: ctx });
      expect(verdict).toBe('persisted-only');
      expect(tracker.calls).toEqual([]);
    });

    test(`${hookKey} — returns persisted-only when commandCtx is undefined`, async () => {
      const hook = LIVE_APPLY_HOOKS[hookKey];
      if (!hook) return;
      const verdict = await hook('my-new-model', {});
      expect(verdict).toBe('persisted-only');
    });

    test(`${hookKey} — undefined newValue returns persisted-only`, async () => {
      const ctx = makeCtx({ providerName });
      const tracker = setModelCapture(ctx);
      const hook = LIVE_APPLY_HOOKS[hookKey];
      if (!hook) return;
      const verdict = await hook(undefined, { commandCtx: ctx });
      expect(verdict).toBe('persisted-only');
      expect(tracker.calls).toEqual([]);
    });
  }
});

describe('LIVE_APPLY_HOOKS — verbose', () => {
  test('records verboseChanged true and returns applied', async () => {
    const ctx = makeCtx();
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.verbose;
    if (!hook) return;
    const verdict = await hook(true, {
      commandCtx: ctx,
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(capture.recorded[0]).toEqual({ verboseChanged: true });
  });

  test('records verboseChanged false and returns applied', async () => {
    const ctx = makeCtx();
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.verbose;
    if (!hook) return;
    const verdict = await hook(false, {
      commandCtx: ctx,
      recordSideEffect: capture.recordSideEffect,
    });
    expect(verdict).toBe('applied');
    expect(capture.recorded[0]).toEqual({ verboseChanged: false });
  });

  test('returns persisted-only when commandCtx is undefined and emits no side-effects', async () => {
    const capture = captureSideEffects();
    const hook = LIVE_APPLY_HOOKS.verbose;
    if (!hook) return;
    const verdict = await hook(true, { recordSideEffect: capture.recordSideEffect });
    expect(verdict).toBe('persisted-only');
    expect(capture.recorded.length).toBe(0);
  });
});

describe('LIVE_APPLY_HOOKS — webSearch.*', () => {
  const KEYS = ['webSearch.provider', 'webSearch.apiKey', 'webSearch.maxResults'];

  for (const key of KEYS) {
    test(`${key} — returns applied when commandCtx is defined`, async () => {
      const ctx = makeCtx();
      const hook = LIVE_APPLY_HOOKS[key];
      expect(hook, `${key} hook should exist`).toBeDefined();
      if (!hook) return;
      const verdict = await hook('any-value', { commandCtx: ctx });
      expect(verdict).toBe('applied');
    });

    test(`${key} — returns persisted-only when commandCtx is undefined`, async () => {
      const hook = LIVE_APPLY_HOOKS[key];
      if (!hook) return;
      const verdict = await hook('any-value', {});
      expect(verdict).toBe('persisted-only');
    });
  }
});

describe('LIVE_APPLY_HOOKS — maxTurns', () => {
  test('is intentionally absent (NOT live-applyable — verified 2026-05-24)', () => {
    // Per spec verification: maxTurns is captured at query() call time
    // from runtime opts, not read-on-demand. Catalog item lacks a hook
    // so the badge says "next session" automatically.
    expect(LIVE_APPLY_HOOKS.maxTurns).toBeUndefined();
  });
});

describe('LIVE_APPLY_HOOKS — permissionMode', () => {
  // 2026-05-24 patch — live-apply via runtime.permissionMode mutation
  // through the new setPermissionMode CommandContext closure. The
  // turns route reads runtime.permissionMode per-request so the next
  // turn picks up the new mode.

  test('calls setPermissionMode with the new mode and returns applied', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      setPermissionMode: (mode: string) => {
        calls.push(mode);
      },
    });
    const hook = LIVE_APPLY_HOOKS.permissionMode;
    if (!hook) return;
    const verdict = await hook('bypass', { commandCtx: ctx });
    expect(verdict).toBe('applied');
    expect(calls).toEqual(['bypass']);
  });

  test('falls back to default when newValue is undefined (unset path)', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      setPermissionMode: (mode: string) => {
        calls.push(mode);
      },
    });
    const hook = LIVE_APPLY_HOOKS.permissionMode;
    if (!hook) return;
    const verdict = await hook(undefined, { commandCtx: ctx });
    expect(verdict).toBe('applied');
    expect(calls).toEqual(['default']);
  });

  test('returns persisted-only when commandCtx is undefined (standalone)', async () => {
    const hook = LIVE_APPLY_HOOKS.permissionMode;
    if (!hook) return;
    const verdict = await hook('ask', {});
    expect(verdict).toBe('persisted-only');
  });

  test('returns persisted-only when setPermissionMode is not exposed (headless dispatch)', async () => {
    // CommandContext without setPermissionMode — dispatch CLI surface
    // doesn't wire the closure; hook must degrade gracefully.
    const ctx = makeCtx();
    const hook = LIVE_APPLY_HOOKS.permissionMode;
    if (!hook) return;
    const verdict = await hook('ask', { commandCtx: ctx });
    expect(verdict).toBe('persisted-only');
  });
});

describe('LIVE_APPLY_HOOKS — registry shape', () => {
  test('all expected keys are present', () => {
    const expected = [
      'theme',
      'defaultModel',
      'providers.anthropic.model',
      'providers.openai.model',
      'providers.openrouter.model',
      'providers.ollama.model',
      'verbose',
      'webSearch.provider',
      'webSearch.apiKey',
      'webSearch.maxResults',
      'permissionMode',
    ];
    for (const key of expected) {
      expect(LIVE_APPLY_HOOKS[key], `hook ${key} should exist`).toBeDefined();
    }
  });

  test('every hook returns a Promise that resolves to applied or persisted-only', async () => {
    const ctx = makeCtx();
    for (const [key, hook] of Object.entries(LIVE_APPLY_HOOKS)) {
      // Use a benign value compatible with all hooks.
      const verdict = await hook('benign-value', {
        commandCtx: ctx,
        recordSideEffect: () => {},
      });
      expect(['applied', 'persisted-only']).toContain(verdict);
      expect(typeof key).toBe('string'); // sanity
    }
  });
});
