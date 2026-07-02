// #32 — `/effort` reasoning-support report must be correct in ROUTER mode.
//
// In router mode the resolved provider is a RouterProvider pseudo-transport
// with NO `apiMode`, so the old `ctx.apiMode = transport.apiMode` was undefined
// and `modelSupportsReasoning(syntheticModel, undefined)` fell to `false` — the
// status wrongly reported "does not support reasoning depth" even when the
// frontier lane (e.g. Claude 4) reasons. `resolveEffortApiMode` resolves the
// FRONTIER lane's apiMode from the resolved metadata so the report is correct,
// while leaving the non-router path byte-identical.

import { describe, expect, test } from 'bun:test';
import { modelSupportsReasoning } from '@yevgetman/sov-sdk/providers/effort';
import { resolveEffortApiMode } from '../../src/server/commandContext.js';

describe('resolveEffortApiMode (#32)', () => {
  test('router mode resolves the frontier lane apiMode (anthropic), not undefined', () => {
    // The synthetic router metadata from runtime.ts: local sov/ollama + frontier
    // anthropic. The transport carries no apiMode.
    const metadata = {
      provider: 'router',
      apiMode: 'router',
      purpose: 'main',
      localProvider: 'ollama',
      frontierProvider: 'anthropic',
    };
    expect(resolveEffortApiMode(metadata)).toBe('anthropic');
  });

  test('router mode → /effort sees a reasoning-capable model (the regression closes)', () => {
    const metadata = {
      provider: 'router',
      apiMode: 'router',
      frontierProvider: 'anthropic',
    };
    const apiMode = resolveEffortApiMode(metadata);
    // runtime.model is the synthetic "local | frontier" display string; it
    // carries the frontier model id, and the local id never matches a frontier
    // reasoning pattern.
    const syntheticModel = 'qwen2.5:14b | claude-sonnet-4-6';
    expect(apiMode).toBeDefined();
    // BEFORE the fix this was modelSupportsReasoning(model, undefined) === false.
    expect(modelSupportsReasoning(syntheticModel, apiMode as 'anthropic')).toBe(true);
  });

  test('router mode with an openai frontier resolves to the openai apiMode', () => {
    const metadata = {
      provider: 'router',
      apiMode: 'router',
      frontierProvider: 'openai',
    };
    expect(resolveEffortApiMode(metadata)).toBe('openai');
    expect(modelSupportsReasoning('qwen2.5:14b | gpt-5', 'openai')).toBe(true);
    // A non-reasoning openai frontier still reports false (no false positive).
    expect(modelSupportsReasoning('qwen2.5:14b | gpt-4o', 'openai')).toBe(false);
  });

  test('non-router mode returns the real wire apiMode unchanged', () => {
    expect(resolveEffortApiMode({ provider: 'anthropic', apiMode: 'anthropic' })).toBe('anthropic');
    expect(resolveEffortApiMode({ provider: 'openai', apiMode: 'openai' })).toBe('openai');
    expect(resolveEffortApiMode({ provider: 'sov', apiMode: 'sov' })).toBe('sov');
  });

  test('a misconfigured router (unknown frontier provider) returns undefined → caller keeps transport apiMode', () => {
    expect(
      resolveEffortApiMode({ apiMode: 'router', frontierProvider: 'not-a-real-provider' }),
    ).toBeUndefined();
    expect(resolveEffortApiMode({ apiMode: 'router' })).toBeUndefined();
  });
});
