// Phase 18 T9 — tests for the real-resolveProvider call path.
//
// modelResolution.test.ts covers the cheap paths (harness-default,
// empty string, unknown name → InvalidModelError) with a hand-rolled
// Runtime literal. T9 adds the explicit-name branch: when the request
// asks for `claude-haiku-4-5-20251001` or any other known SUPPORTED_MODELS
// entry, the resolver builds a per-request transport via resolveProvider.
//
// These tests exercise the resolveProvider call path against a real
// buildRuntime + temp harnessHome. The mock provider boot path still
// works for harness-default; the explicit-name branch tests assert the
// resolver was actually called and either (a) returned a usable transport
// when credentials are available in the env, or (b) threw a
// CredentialUnavailableError when they aren't. Either outcome proves the
// branch is wired — what we MUST guard against is the explicit-name
// request silently falling back to the runtime's mock transport (the
// pre-T9 behavior had no explicit-name branch, so the test asserts
// behavior is materially different now).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import {
  InvalidModelError,
  SUPPORTED_MODELS,
  resolveModelForRequest,
} from '../../src/openai/modelResolution.js';
import { CredentialUnavailableError } from '../../src/providers/errors.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

let home: string;
let runtime: Runtime;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'sov-openai-resolve-real-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  __test_resetProjectIdCache();
  runtime = await buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
});

afterEach(async () => {
  await runtime?.dispose();
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
  rmSync(home, { recursive: true, force: true });
});

describe('resolveModelForRequest — real resolveProvider call path (T9)', () => {
  test('harness-default returns runtime defaults (no resolver call)', () => {
    const result = resolveModelForRequest(runtime, 'harness-default', home);
    expect(result.transport).toBe(runtime.resolvedProvider.transport);
    expect(result.model).toBe(runtime.model);
  });

  test('empty string returns runtime defaults (no resolver call)', () => {
    const result = resolveModelForRequest(runtime, '', home);
    expect(result.transport).toBe(runtime.resolvedProvider.transport);
    expect(result.model).toBe(runtime.model);
  });

  test('claude-haiku-4-5-20251001 takes the explicit-name branch via resolveProvider', () => {
    // The branch behavior depends on whether ANTHROPIC_API_KEY is set in
    // the env:
    //   - present: resolveProvider returns a real AnthropicProvider, the
    //     returned transport is NOT the runtime's mock transport, and
    //     result.model echoes the requested model name verbatim.
    //   - absent:  resolveProvider throws CredentialUnavailableError —
    //     which is itself proof that the explicit-name branch ran (the
    //     mock runtime would never throw that on its own).
    // Either outcome is acceptable; both prove the explicit-name branch
    // was taken instead of silently routing to the runtime mock.
    try {
      const result = resolveModelForRequest(runtime, 'claude-haiku-4-5-20251001', home);
      // Credentials present in test env — assert we got a different
      // transport than the mock runtime would have returned.
      expect(result.transport).not.toBe(runtime.resolvedProvider.transport);
      expect(result.model).toBe('claude-haiku-4-5-20251001');
    } catch (err) {
      // Credentials absent — the resolver threw, proving the branch ran.
      expect(err).toBeInstanceOf(CredentialUnavailableError);
    }
  });

  test('gpt-4o-mini takes the explicit-name branch via resolveProvider', () => {
    // Same logic as the claude case, but for the OpenAI family. Either a
    // real OpenAIProvider comes back, or a CredentialUnavailableError is
    // thrown — both prove the branch ran.
    try {
      const result = resolveModelForRequest(runtime, 'gpt-4o-mini', home);
      expect(result.transport).not.toBe(runtime.resolvedProvider.transport);
      expect(result.model).toBe('gpt-4o-mini');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialUnavailableError);
    }
  });

  test('runtime state is not mutated by explicit-name resolution', () => {
    // The T9 invariant: even if resolveProvider is called, the runtime's
    // bootstrap transport + model are untouched. We only confirm this
    // by snapshotting before/after and asserting equality — the call
    // may throw (no credentials) but the runtime must survive either way.
    const beforeTransport = runtime.resolvedProvider.transport;
    const beforeModel = runtime.model;
    try {
      resolveModelForRequest(runtime, 'claude-opus-4-7', home);
    } catch {
      // expected when no anthropic key in env
    }
    expect(runtime.resolvedProvider.transport).toBe(beforeTransport);
    expect(runtime.model).toBe(beforeModel);
  });

  test('throws InvalidModelError on unknown model', () => {
    expect(() => resolveModelForRequest(runtime, 'gpt-99-imaginary', home)).toThrow(
      InvalidModelError,
    );
  });

  test('InvalidModelError message includes the full supported model list', () => {
    try {
      resolveModelForRequest(runtime, 'gpt-99-imaginary', home);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidModelError);
      const message = (err as Error).message;
      for (const supported of SUPPORTED_MODELS) {
        expect(message).toContain(supported);
      }
    }
  });
});
