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
});
