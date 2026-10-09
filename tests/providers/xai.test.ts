// Direct xAI API-key provider (`xai`). Acceptance A1: a Grok API key resolves to
// api.x.ai, never OpenRouter, and never the `grok` subscription login.
// Fake keys and temp homes only; no provider stream is invoked.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import { redactSecrets } from '@yevgetman/sov-sdk/permissions/secretRedactor';
import { CredentialUnavailableError } from '@yevgetman/sov-sdk/providers/errors';
import { PROVIDER_REGISTRY } from '@yevgetman/sov-sdk/providers/models';
import { resolveProvider } from '@yevgetman/sov-sdk/providers/resolver';

const FAKE_XAI_KEY = 'xai-FAKEKEY0000000000000000000000000000';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'harness-xai-test-'));
}

describe('xai provider', () => {
  test('registry entry is the direct xAI OpenAI-compatible lane', () => {
    const entry = PROVIDER_REGISTRY.xai;
    expect(entry?.apiMode).toBe('openai');
    expect(entry?.defaultBaseUrl).toBe('https://api.x.ai/v1');
    expect(entry?.authEnvVar).toBe('XAI_API_KEY');
  });

  test('XAI_API_KEY resolves to api.x.ai, not OpenRouter', () => {
    const resolved = resolveProvider('xai', undefined, {
      env: { XAI_API_KEY: FAKE_XAI_KEY, OPENROUTER_API_KEY: 'sk-or-should-not-be-used-000000' },
      harnessHome: tempHome(),
      settings: {},
    });
    expect(resolved.transport.name).toBe('xai');
    expect(resolved.baseUrl).toBe('https://api.x.ai/v1');
    expect(resolved.authType).toBe('api_key');
    expect(resolved.metadata.provider).toBe('xai');
    expect(resolved.metadata.credentialId).toBe('XAI_API_KEY');
    expect(resolved.metadata.auth).toBeUndefined();
  });

  test('providers.xai config key and model are honored', () => {
    const resolved = resolveProvider('xai', undefined, {
      env: {},
      harnessHome: tempHome(),
      settings: { providers: { xai: { apiKey: FAKE_XAI_KEY, model: 'grok-custom' } } },
    });
    expect(resolved.model).toBe('grok-custom');
    expect(resolved.metadata.credentialId).toBe('config-api-key');
  });

  test('missing key throws CredentialUnavailableError without falling back', () => {
    expect(() =>
      resolveProvider('xai', undefined, {
        env: { OPENROUTER_API_KEY: 'sk-or-should-not-be-used-000000' },
        harnessHome: tempHome(),
        settings: {},
      }),
    ).toThrow(CredentialUnavailableError);
  });

  test('grok stays the subscription name and still refuses without opt-in', () => {
    expect(() =>
      resolveProvider('grok', undefined, {
        env: { XAI_API_KEY: FAKE_XAI_KEY },
        harnessHome: tempHome(),
        settings: {},
      }),
    ).toThrow(CredentialUnavailableError);
  });

  test('settings schema accepts providers.xai', () => {
    const parsed = SettingsSchema.safeParse({ providers: { xai: { apiKey: 'x', model: 'm' } } });
    expect(parsed.success).toBe(true);
  });

  test('xai keys are redacted by the shared provider-key patterns', () => {
    const out = redactSecrets(`key=${FAKE_XAI_KEY}`);
    expect(out.redacted).not.toContain(FAKE_XAI_KEY);
    expect(out.hits[0]?.kind).toBe('xai');
  });
});
