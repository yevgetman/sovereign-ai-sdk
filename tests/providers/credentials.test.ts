// Credential pool and rate-limit guard tests.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialPool } from '@yevgetman/sov-sdk/providers/credentials/pool';
import {
  RateLimitGuard,
  RateLimitGuardError,
  resetTimeFromHeaders,
} from '@yevgetman/sov-sdk/providers/credentials/rateGuard';

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

  // FINDING #15: two long-lived processes sharing the SAME provider must not
  // clobber each other's per-credential rows. Process B marks a slot exhausted
  // (writes disk); Process A — whose boot snapshot still shows that slot ok —
  // marks a DIFFERENT slot ok and persists. A's persist must NOT resurrect the
  // slot B locked out: merge is per-credential-row, not per-provider-map.
  test('same-provider persist preserves another process row it did not touch', () => {
    const path = join(tempDir(), 'credentials.json');
    // Process A boots seeing both slots.
    const procA = new CredentialPool(
      'openai',
      [
        { id: 'slotA', provider: 'openai', authType: 'api_key', secret: 'a' },
        { id: 'slotB', provider: 'openai', authType: 'api_key', secret: 'b' },
      ],
      { path, now: () => 100 },
    );
    // Process B (separate pool, same file + provider) boots from the same disk.
    const procB = new CredentialPool(
      'openai',
      [
        { id: 'slotA', provider: 'openai', authType: 'api_key', secret: 'a' },
        { id: 'slotB', provider: 'openai', authType: 'api_key', secret: 'b' },
      ],
      { path, now: () => 100 },
    );
    // B locks out slotB (rate limit) and writes disk.
    procB.markExhausted('slotB', '429', 9999);
    // A — with a STALE in-memory snapshot showing slotB ok — only touches slotA.
    procA.markOk('slotA');

    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      credentials?: Record<
        string,
        Record<string, { status: string; cooldownUntil: number | null }>
      >;
    };
    // A's own touched row reflects A's mutation.
    expect(state.credentials?.openai?.slotA?.status).toBe('ok');
    // B's lockout on the slot A never touched must survive A's persist.
    expect(state.credentials?.openai?.slotB?.status).toBe('exhausted');
    expect(state.credentials?.openai?.slotB?.cooldownUntil).toBe(9999);
  });

  // FINDING #15: the clobber must be closed even when the SAME credential id is
  // touched by both processes — last-writer-per-credential. A selects (marks ok)
  // at boot; B then exhausts the same slot; A's later markOk would otherwise
  // overwrite B's fresh exhausted marker with A's stale ok. The merge must not
  // resurrect a row A did not mutate AFTER B wrote it. Here A's final mutation
  // IS on the shared slot, so last-writer wins for that slot, but a third
  // untouched slot B exhausted must still survive.
  test('same-provider persist does not resurrect an untouched sibling row', () => {
    const path = join(tempDir(), 'credentials.json');
    const procA = new CredentialPool(
      'openai',
      [
        { id: 'shared', provider: 'openai', authType: 'api_key', secret: 's' },
        { id: 'other', provider: 'openai', authType: 'api_key', secret: 'o' },
      ],
      { path, now: () => 100 },
    );
    const procB = new CredentialPool(
      'openai',
      [
        { id: 'shared', provider: 'openai', authType: 'api_key', secret: 's' },
        { id: 'other', provider: 'openai', authType: 'api_key', secret: 'o' },
      ],
      { path, now: () => 100 },
    );
    // B locks out the 'other' slot, then A persists a mutation on 'shared'.
    procB.markExhausted('other', '429', 7777);
    procA.markOk('shared');
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      credentials?: Record<string, Record<string, { status: string }>>;
    };
    expect(state.credentials?.openai?.other?.status).toBe('exhausted');
  });

  // D2: memory mode — the SDK embed path (createAgent) builds the pool WITHOUT
  // touching disk (no default-path resolution → no resolveHarnessHome() mkdir,
  // no credentials.json), yet selection + lockout logic still work in memory.
  test('memory mode selects and locks out credentials without reading or writing disk', () => {
    const home = join(tempDir(), 'nonexistent-home');
    const prevHome = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      let now = 100;
      const pool = new CredentialPool(
        'openai',
        [
          { id: 'a', provider: 'openai', authType: 'api_key', secret: 'sk-a' },
          { id: 'b', provider: 'openai', authType: 'api_key', secret: 'sk-b' },
        ],
        { memory: true, now: () => now },
      );
      // Selection works in memory.
      const first = pool.select();
      expect(first?.credential.id).toBe('a');
      expect(first?.secret).toBe('sk-a');
      // Lockout logic works in memory (exhaust 'a' → 'b' selected).
      pool.markExhausted('a', '429', 500);
      expect(pool.select()?.credential.id).toBe('b');
      now = 600;
      expect(pool.select()?.credential.id).toBe('a');
      // No default credential-state path was ever resolved → HARNESS_HOME and
      // credentials.json were never created.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(join(home, 'credentials.json'))).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset requires delete (test cleanup).
      if (prevHome === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = prevHome;
    }
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

  // D2: memory mode — the embed path builds the guard WITHOUT touching disk (no
  // defaultRateRoot() → no resolveHarnessHome() mkdir, no rate_limits write),
  // yet the 429 backoff still works via in-memory state.
  test('memory mode backs off on a 429 without reading or writing disk', async () => {
    const home = join(tempDir(), 'nonexistent-home');
    const prevHome = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const guard = new RateLimitGuard('anthropic', {
        memory: true,
        now: () => 1_000,
        maxSleepSeconds: 600,
      });
      // A long-cooldown 429 (reset in 30 min) is recorded in memory.
      guard.markRateLimited({ 'retry-after': '1800' }, 'rate limited');
      // beforeRequest reads the IN-MEMORY state and fails fast for the long wait.
      await expect(guard.beforeRequest()).rejects.toThrow(RateLimitGuardError);
      // Nothing was ever written to disk.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(join(home, 'rate_limits'))).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset requires delete (test cleanup).
      if (prevHome === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = prevHome;
    }
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

  // FINDING #16: OpenAI emits x-ratelimit-reset-requests as a Go-duration
  // string ('6m0s', '1.5s', '880ms'), not a number. parseResetHeader must
  // parse it instead of dropping to the no-header floor.
  test('parses Go-duration reset headers (OpenAI native format)', () => {
    const now = 1000;
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset-requests': '6m0s' }, now)).toBe(now + 360);
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset-requests': '1.5s' }, now)).toBe(now + 1.5);
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset-requests': '880ms' }, now)).toBe(now + 0.88);
    // Compound multi-unit duration.
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset-requests': '1h2m3s' }, now)).toBe(
      now + 3600 + 120 + 3,
    );
    // Generic x-ratelimit-reset in Go-duration form is honored too.
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset': '90s' }, now)).toBe(now + 90);
  });

  // FINDING #16: a bare numeric value (relative seconds / epoch) must still
  // parse — the Go-duration path must not regress the numeric path.
  test('numeric reset headers still parse after Go-duration support', () => {
    const now = 100;
    expect(resetTimeFromHeaders({ 'x-ratelimit-reset-requests': '20' }, now)).toBe(120);
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

  // F25: a completed (non-aborted) rate-limit wait must remove its 'abort'
  // listener from the (shared, long-lived) signal. Relying on { once: true } is
  // insufficient — it only auto-removes a listener that actually FIRES, so each
  // successful backoff leaks one listener on the signal.
  test('a completed rate-limit wait removes its abort listener (no leak on a shared signal)', async () => {
    const root = tempDir();
    // Fixed clock: a tiny remaining cooldown so beforeRequest sleeps briefly and
    // then RESOLVES (the non-abort path) instead of failing fast.
    const guard = new RateLimitGuard('openai', { root, now: () => 100 });
    guard.markRateLimited({ 'retry-after': '0.02' }, '429'); // exhausted_until = 100.02

    // A minimal signal that records its 'abort' listeners so we can assert none
    // survive a resolved sleep. sleepSeconds only touches .aborted +
    // add/removeEventListener, so this stands in for a shared AbortSignal.
    const abortListeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, cb: () => void) => {
        abortListeners.add(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        abortListeners.delete(cb);
      },
    } as unknown as AbortSignal;

    await guard.beforeRequest(signal);

    expect(abortListeners.size).toBe(0);
  });
});
