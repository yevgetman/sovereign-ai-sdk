// Provider resolver tests. Uses fake credentials and temp harness homes; no
// provider stream is invoked.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialUnavailableError } from '@yevgetman/sov-sdk/providers/errors';
import { contextLengthFor } from '@yevgetman/sov-sdk/providers/models';
import { resolveProvider } from '@yevgetman/sov-sdk/providers/resolver';
import { RouterProvider } from '@yevgetman/sov-sdk/providers/router';

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
    const resolved = resolveProvider('sov', 'mlx-community/Qwen3-4B-4bit', {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('sov');
    expect(resolved.transport.apiMode).toBe('sov');
    expect(resolved.authType).toBe('none');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(resolved.model).toBe('mlx-community/Qwen3-4B-4bit');
  });

  test('sov uses its registered default model when none is supplied', () => {
    const resolved = resolveProvider('sov', undefined, {
      env: {},
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.model).toBe('mlx-community/Qwen3-4B-4bit');
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
        localModel: 'mlx-community/Qwen3-4B-4bit',
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
    expect(resolved.model).toBe('mlx-community/Qwen3-4B-4bit');
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

  // The manifest lane — the model-router organ's current binding (apiMode
  // 'router'). Keyed (MANIFEST_API_KEY, unlike the keyless sov/ollama lanes),
  // routes `auto` to a self-hosted Manifest instance on the loopback default.
  // memory credentialState mirrors the createAgent embed path (no disk).
  test('manifest resolves to the RouterProvider with router defaults', () => {
    const resolved = resolveProvider('manifest', undefined, {
      env: { MANIFEST_API_KEY: 'mnfst-test' },
      credentialState: 'memory',
      settings: {},
    });
    expect(resolved.transport.name).toBe('manifest');
    expect(resolved.transport.apiMode).toBe('router');
    expect(resolved.client).toBeInstanceOf(RouterProvider);
    expect(resolved.model).toBe('auto');
    expect(resolved.baseUrl).toBe('http://localhost:2099/v1');
    expect(resolved.authType).toBe('api_key');
    // The conservative 128k floor rides through contextLengthFor('manifest','auto').
    expect(resolved.contextLength).toBe(128_000);
    expect(resolved.metadata).toMatchObject({ provider: 'manifest', apiMode: 'router' });
  });

  test('manifest without MANIFEST_API_KEY throws CredentialUnavailableError', () => {
    // manifest is keyed (isKeylessProvider is false), so an absent key fails
    // closed — unlike the keyless sov/ollama loopback lanes above.
    expect(() =>
      resolveProvider('manifest', undefined, {
        env: {},
        credentialState: 'memory',
        settings: {},
      }),
    ).toThrow(CredentialUnavailableError);
  });

  test('manifest threads config headers into the RouterProvider (auth never masked)', () => {
    const resolved = resolveProvider('manifest', undefined, {
      env: { MANIFEST_API_KEY: 'mnfst-test' },
      credentialState: 'memory',
      settings: { providers: { manifest: { headers: { 'x-tier': 'cheap' } } } },
    });
    // requestHeaders() is the seam the transport merges its static routing-hint
    // headers through; reach it via the same structural cast the ollama
    // buildKwargs assertions above use (resolved.client is the UNwrapped transport).
    const headers = (
      resolved.client as unknown as { requestHeaders(): Record<string, string> }
    ).requestHeaders();
    expect(headers['x-tier']).toBe('cheap');
    // The real bearer + JSON content-type win — a hint header can't mask them.
    expect(headers.authorization).toBe('Bearer mnfst-test');
    expect(headers['content-type']).toBe('application/json');
  });

  test('contextLengthFor(manifest, auto) is the conservative 128k floor', () => {
    // `auto` is not in MODEL_CONTEXT, so it falls back to the registry's floor.
    expect(contextLengthFor('manifest', 'auto')).toBe(128_000);
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

  // D2: disk mode is the DEFAULT (no credentialState / an explicit harnessHome)
  // so the CLI/gateway keep cross-process credential state. Regression witness:
  // a resolve with an explicit harnessHome + a key writes credentials.json.
  test('disk mode (explicit harnessHome) writes credentials.json — CLI/gateway unchanged', () => {
    const home = tempHome();
    resolveProvider('anthropic', 'claude-x', {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      harnessHome: home,
      settings: {},
    });
    expect(existsSync(join(home, 'credentials.json'))).toBe(true);
  });

  // D2: memory mode is what the SDK embed path (createAgent) passes. Resolution
  // reaches the CredentialPool + RateLimitGuard seams (real provider + key) but
  // touches NO disk — HARNESS_HOME is never mkdir'd, credentials.json never
  // written. RED before the fix (the seams defaulted to resolveHarnessHome()).
  test('memory mode resolves without creating HARNESS_HOME or credentials.json (D2)', () => {
    const home = join(
      tmpdir(),
      `harness-provider-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const prevHome = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const resolved = resolveProvider('anthropic', 'claude-x', {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        credentialState: 'memory',
        settings: {},
      });
      expect(resolved.transport.name).toBe('anthropic');
      expect(resolved.metadata.credentialId).toBeDefined();
      expect(existsSync(home)).toBe(false);
      expect(existsSync(join(home, 'credentials.json'))).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset requires delete (test cleanup).
      if (prevHome === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = prevHome;
    }
  });
});
