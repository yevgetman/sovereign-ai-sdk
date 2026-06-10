// Credential pool and rate-limit guard tests.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialPool } from '../../src/providers/credentials/pool.js';
import {
  RateLimitGuard,
  RateLimitGuardError,
  resetTimeFromHeaders,
} from '../../src/providers/credentials/rateGuard.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-credential-test-'));
}

describe('CredentialPool', () => {
  test('persists metadata without raw credential values', () => {
    const path = join(tempDir(), 'credentials.json');
    const pool = new CredentialPool(
      'openai',
      [{ id: 'primary', provider: 'openai', authType: 'api_key', secret: 'sk-secret' }],
      { path, now: () => 100 },
    );
    const selected = pool.select();
    expect(selected?.credential.id).toBe('primary');
    expect(selected?.secret).toBe('sk-secret');

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('"primary"');
    expect(text).not.toContain('sk-secret');
  });

  test('skips exhausted credentials until cooldown expires', () => {
    let now = 100;
    const pool = new CredentialPool(
      'openai',
      [
        { id: 'a', provider: 'openai', authType: 'api_key', secret: 'a' },
        { id: 'b', provider: 'openai', authType: 'api_key', secret: 'b' },
      ],
      { path: join(tempDir(), 'credentials.json'), now: () => now },
    );
    pool.markExhausted('a', '429', 500);
    expect(pool.select()?.credential.id).toBe('b');
    now = 600;
    expect(pool.select()?.credential.id).toBe('a');
  });

  // FIX 1: auth_failed must not be permanent. The credential id is the slot
  // name (env-var / config key), so a rotated secret under the same slot must
  // clear the stale auth_failed lockout.
  test('auth_failed clears when the secret value changes under the same id', () => {
    const path = join(tempDir(), 'credentials.json');
    const first = new CredentialPool(
      'openai',
      [{ id: 'OPENAI_API_KEY', provider: 'openai', authType: 'api_key', secret: 'sk-bad' }],
      { path, now: () => 100 },
    );
    first.markAuthFailed('OPENAI_API_KEY', '401');
    // Same slot, still the bad secret → still locked out.
    const stillBad = new CredentialPool(
      'openai',
      [{ id: 'OPENAI_API_KEY', provider: 'openai', authType: 'api_key', secret: 'sk-bad' }],
      { path, now: () => 200 },
    );
    expect(stillBad.select()).toBeNull();
    // User rotates the key under the same slot → auth_failed must clear.
    const rotated = new CredentialPool(
      'openai',
      [{ id: 'OPENAI_API_KEY', provider: 'openai', authType: 'api_key', secret: 'sk-good' }],
      { path, now: () => 300 },
    );
    const selected = rotated.select();
    expect(selected?.credential.id).toBe('OPENAI_API_KEY');
    expect(selected?.secret).toBe('sk-good');
  });

  // FIX 1: a transient 403 must self-heal after a bounded cooldown rather than
  // bricking the credential forever.
  test('auth_failed self-heals after the cooldown elapses', () => {
    let now = 100;
    const path = join(tempDir(), 'credentials.json');
    const pool = new CredentialPool(
      'openai',
      [{ id: 'OPENAI_API_KEY', provider: 'openai', authType: 'api_key', secret: 'sk-secret' }],
      { path, now: () => now },
    );
    pool.markAuthFailed('OPENAI_API_KEY', '403 transient');
    expect(pool.select()).toBeNull();
    // After the cooldown window the same (unchanged) secret is retried.
    now = 100 + 10 * 60 + 1;
    expect(pool.select()?.credential.id).toBe('OPENAI_API_KEY');
  });

  // FIX 2: two long-lived processes (different providers) must not clobber
  // each other's rows in the shared credentials.json.
  test('interleaved persists for different providers do not clobber each other', () => {
    const path = join(tempDir(), 'credentials.json');
    const openai = new CredentialPool(
      'openai',
      [{ id: 'OPENAI_API_KEY', provider: 'openai', authType: 'api_key', secret: 'sk-openai' }],
      { path, now: () => 100 },
    );
    const anthropic = new CredentialPool(
      'anthropic',
      [
        {
          id: 'ANTHROPIC_API_KEY',
          provider: 'anthropic',
          authType: 'api_key',
          secret: 'sk-anthropic',
        },
      ],
      { path, now: () => 100 },
    );
    // Interleave mutations: each persist must merge, not overwrite the file.
    openai.markExhausted('OPENAI_API_KEY', '429', 9999);
    anthropic.markExhausted('ANTHROPIC_API_KEY', '429', 8888);
    openai.markOk('OPENAI_API_KEY');

    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      credentials?: Record<
        string,
        Record<string, { status: string; cooldownUntil: number | null }>
      >;
    };
    expect(state.credentials?.openai?.OPENAI_API_KEY?.status).toBe('ok');
    // Anthropic's concurrent update must survive openai's later persist.
    expect(state.credentials?.anthropic?.ANTHROPIC_API_KEY?.status).toBe('exhausted');
    expect(state.credentials?.anthropic?.ANTHROPIC_API_KEY?.cooldownUntil).toBe(8888);
  });
});

describe('RateLimitGuard', () => {
  test('parses reset headers by priority', () => {
    const reset = resetTimeFromHeaders(
      {
        'retry-after': '10',
        'x-ratelimit-reset-requests': '20',
        'x-ratelimit-reset-requests-1h': '30',
      },
      100,
    );
    expect(reset).toBe(130);
  });

  test('writes shared guard file and fails fast for long cooldowns', async () => {
    const root = tempDir();
    const guard = new RateLimitGuard('openai', {
      root,
      now: () => 100,
      maxSleepSeconds: 1,
    });
    guard.markRateLimited({ 'retry-after': '30' }, '429');
    expect(existsSync(join(root, 'openai.json'))).toBe(true);
    await expect(guard.beforeRequest()).rejects.toThrow(RateLimitGuardError);
  });

  // FIX 3: a header-less 429 must NOT lock the provider for a full hour.
  test('header-less 429 yields a minutes-scale backoff, not an hour', () => {
    const root = tempDir();
    const guard = new RateLimitGuard('openai', { root, now: () => 1000 });
    const state = guard.markRateLimited(undefined, '429 no headers');
    const delay = state.exhausted_until - 1000;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5 * 60);
  });

  // FIX 3: OpenRouter-style X-RateLimit-Reset is epoch-MS; it must be parsed to
  // the correct absolute reset time. Uses a realistic epoch so the magnitude
  // heuristic (epoch-ms vs epoch-s vs relative) is exercised honestly.
  test('parses X-RateLimit-Reset epoch-ms header to the correct delay', () => {
    const now = 1_700_000_000; // realistic epoch seconds
    const resetMs = (now + 42) * 1000; // 42s in the future, expressed in ms
    const reset = resetTimeFromHeaders({ 'x-ratelimit-reset': String(resetMs) }, now);
    expect(reset).toBe(now + 42);
  });

  // FIX 3: repeated immediate header-less 429s should grow the backoff but stay
  // well under an hour.
  test('repeated header-less 429s grow the backoff but stay under an hour', () => {
    const root = tempDir();
    let now = 1000;
    const guard = new RateLimitGuard('openai', { root, now: () => now });
    const first = guard.markRateLimited(undefined, '429').exhausted_until - now;
    now += 1; // immediate retry, still rate-limited
    const second = guard.markRateLimited(undefined, '429').exhausted_until - now;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(60 * 60);
  });
});
