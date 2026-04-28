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
    });
    expect(resolved.transport.name).toBe('anthropic');
    expect(resolved.model).toBe('claude-haiku-4-5-20251001');
    expect(resolved.authType).toBe('api_key');
  });

  test('--provider openai uses OpenAI defaults and env credential', () => {
    const resolved = resolveProvider('openai', undefined, {
      env: { OPENAI_API_KEY: 'sk-openai-test' },
      harnessHome: tempHome(),
    });
    expect(resolved.transport.name).toBe('openai');
    expect(resolved.model).toBe('gpt-4o-mini');
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('ollama resolves without a credential', () => {
    const resolved = resolveProvider('ollama', undefined, { env: {}, harnessHome: tempHome() });
    expect(resolved.transport.name).toBe('ollama');
    expect(resolved.authType).toBe('none');
    expect(resolved.model).toBe('qwen2.5:3b');
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
