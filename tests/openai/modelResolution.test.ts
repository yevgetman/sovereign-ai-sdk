// Phase 18 T2 — tests for the per-request model-name → provider/model
// resolver. v0 (T2) supports the magic name `harness-default` (and empty
// string) returning the runtime's bootstrapped provider/model. Any other
// model name throws InvalidModelError so the handler can 400 with the
// supported model list. Per-request provider resolution for explicit model
// names (claude-*, gpt-*) is deferred to T9.

import { describe, expect, test } from 'bun:test';
import {
  InvalidModelError,
  SUPPORTED_MODELS,
  resolveModelForRequest,
} from '../../src/openai/modelResolution.js';
import type { LLMProvider } from '../../src/providers/types.js';
import type { Runtime } from '../../src/server/runtime.js';

function makeMinimalRuntime(): Runtime {
  // Only the fields modelResolution.ts reads need to be populated. Tests
  // narrow to the resolveModelForRequest contract; the runtime literal
  // here is intentionally minimal — the full Runtime shape is overkill
  // for a pure resolver and would require booting the mock provider.
  const fakeTransport = { name: 'mock' } as unknown as LLMProvider;
  return {
    model: 'mock-haiku',
    resolvedProvider: {
      transport: fakeTransport,
      client: fakeTransport,
      baseUrl: 'mock://local',
      model: 'mock-haiku',
      contextLength: 200_000,
      authType: 'none',
      metadata: { provider: 'mock' },
    },
  } as unknown as Runtime;
}

// Sentinel harnessHome; the harness-default and unknown-name branches both
// short-circuit before any disk access, so these tests don't need a real
// directory. T9 tests in modelResolution.real.test.ts use a real temp dir
// because the explicit-name branch calls resolveProvider().
const HOME = '/tmp/openai-modelresolution-unused';

describe('resolveModelForRequest', () => {
  test('harness-default returns runtime bootstrap transport + model', () => {
    const runtime = makeMinimalRuntime();
    const result = resolveModelForRequest(runtime, 'harness-default', HOME);
    expect(result.transport).toBe(runtime.resolvedProvider.transport);
    expect(result.model).toBe(runtime.model);
  });

  test('empty string is treated as harness-default', () => {
    const runtime = makeMinimalRuntime();
    const result = resolveModelForRequest(runtime, '', HOME);
    expect(result.transport).toBe(runtime.resolvedProvider.transport);
    expect(result.model).toBe(runtime.model);
  });

  test('unknown model throws InvalidModelError', () => {
    const runtime = makeMinimalRuntime();
    expect(() => resolveModelForRequest(runtime, 'gpt-99-nonexistent', HOME)).toThrow(
      InvalidModelError,
    );
  });

  test('InvalidModelError carries the supported model list in the message', () => {
    const runtime = makeMinimalRuntime();
    try {
      resolveModelForRequest(runtime, 'gpt-99-nonexistent', HOME);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidModelError);
      const msg = (err as InvalidModelError).message;
      for (const supported of SUPPORTED_MODELS) {
        expect(msg).toContain(supported);
      }
    }
  });

  test('SUPPORTED_MODELS list includes harness-default and at least one model per family', () => {
    expect(SUPPORTED_MODELS).toContain('harness-default');
    expect(SUPPORTED_MODELS.some((m) => m.startsWith('claude-'))).toBe(true);
    expect(SUPPORTED_MODELS.some((m) => m.startsWith('gpt-'))).toBe(true);
  });
});
