// Provider resolver tests. Uses fake credentials and temp harness homes; no
// provider stream is invoked.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialUnavailableError } from '../../src/providers/errors.js';
import { resolveProvider } from '../../src/providers/resolver.js';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'harness-provider-test-'));
}

describe('resolveProvider', () => {
  test('defaults to anthropic and reads ANTHROPIC_API_KEY', () => {
    const resolved = resolveProvider(undefined, undefined, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('anthropic');
    expect(resolved.model).toBe('claude-haiku-4-5-20251001');
    expect(resolved.authType).toBe('api_key');
  });

  test('--provider openai uses OpenAI defaults and env credential', () => {
    const resolved = resolveProvider('openai', undefined, {
      env: { OPENAI_API_KEY: 'sk-openai-test' },
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('openai');
    expect(resolved.model).toBe('gpt-4o-mini');
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('ollama resolves without a credential', () => {
    const resolved = resolveProvider('ollama', undefined, {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('ollama');
    expect(resolved.authType).toBe('none');
    expect(resolved.model).toBe('qwen2.5:3b');
  });

  test('sov resolves keyless against the loopback default', () => {
    // The local Sovereign engine lane: no API key in env/config, must NOT
    // throw `unknown provider` or `CredentialUnavailableError`, and binds
    // to the loopback default with authType 'none'.
    const resolved = resolveProvider('sov', 'sovereign', {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('sov');
    expect(resolved.transport.apiMode).toBe('sov');
    expect(resolved.authType).toBe('none');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(resolved.model).toBe('sovereign');
  });

  test('sov uses its registered default model when none is supplied', () => {
    const resolved = resolveProvider('sov', undefined, {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.model).toBe('sovereign');
    expect(resolved.authType).toBe('none');
  });

  test('sov honors a config baseUrl override', () => {
    const resolved = resolveProvider('sov', undefined, {
      env: {},
      harnessHome: tempHome(),
      settings: { providers: { sov: { baseUrl: 'http://127.0.0.1:9001/v1' } } },
    });
    expect(resolved.baseUrl).toBe('http://127.0.0.1:9001/v1');
    expect(resolved.authType).toBe('none');
  });

  test('router local lane resolves keyless when router.localProvider is sov', () => {
    // Mirrors src/server/runtime.ts: the router resolves its local lane via
    // resolveProvider(router.localProvider, router.localModel). With sov as
    // the local lane and no credentials anywhere, this must succeed keyless —
    // the lane preflight (src/router/preflight.ts) drives the same call.
    const settings = {
      router: {
        localProvider: 'sov',
        localModel: 'sovereign',
        frontierProvider: 'anthropic',
      },
    } as const;
    const resolved = resolveProvider(settings.router.localProvider, settings.router.localModel, {
      env: {},
      harnessHome: tempHome(),
      settings,
    });
    expect(resolved.transport.name).toBe('sov');
    expect(resolved.transport.apiMode).toBe('sov');
    expect(resolved.authType).toBe('none');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(resolved.model).toBe('sovereign');
  });

  test('ollama transport receives num_ctx from registered model context length', () => {
    const resolved = resolveProvider('ollama', 'qwen2.5:7b', {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    const body = (
      resolved.client as unknown as {
        buildKwargs(req: {
          model: string;
          system: never[];
          messages: never[];
          maxTokens: number;
        }): { options?: { num_ctx?: number } };
      }
    ).buildKwargs({ model: 'qwen2.5:7b', system: [], messages: [], maxTokens: 16 });
    expect(body.options?.num_ctx).toBe(32768);
  });

  test('ollama numCtx config override wins over registered context length', () => {
    const resolved = resolveProvider('ollama', 'qwen2.5:7b', {
      env: {},
      harnessHome: tempHome(),
      settings: {
        providers: { ollama: { model: 'qwen2.5:7b', numCtx: 8192 } },
      },
    });
    const body = (
      resolved.client as unknown as {
        buildKwargs(req: {
          model: string;
          system: never[];
          messages: never[];
          maxTokens: number;
        }): { options?: { num_ctx?: number } };
      }
    ).buildKwargs({ model: 'qwen2.5:7b', system: [], messages: [], maxTokens: 16 });
    expect(body.options?.num_ctx).toBe(8192);
  });

  test('missing API key fails closed for API-key providers', () => {
    expect(() =>
      resolveProvider('openai', undefined, { env: {}, harnessHome: tempHome() }),
    ).toThrow(CredentialUnavailableError);
  });

  test('settings provider config overrides defaults', () => {
    const resolved = resolveProvider(undefined, 'override-model', {
      env: {},
      harnessHome: tempHome(),
      settings: {
        defaultProvider: 'openrouter',
        providers: {
          openrouter: {
            apiKey: 'sk-router',
            baseUrl: 'https://router.example/v1',
            model: 'anthropic/claude-haiku-4.5',
          },
        },
      },
    });
    expect(resolved.transport.name).toBe('openrouter');
    expect(resolved.baseUrl).toBe('https://router.example/v1');
    expect(resolved.model).toBe('override-model');
  });
});
