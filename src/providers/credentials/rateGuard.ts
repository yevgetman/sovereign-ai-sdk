// Cross-session rate-limit guard. A 429 in one process writes a shared JSON
// sentinel so other sessions pause or fail fast instead of amplifying retries.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type HeaderLike = Headers | Record<string, string | null | undefined>;

export type RateLimitState = {
  exhausted_until: number;
  reason: string;
  detected_at: number;
};

export type RateLimitGuardOpts = {
  root?: string;
  now?: () => number;
  maxSleepSeconds?: number;
};

export class RateLimitGuardError extends Error {
  constructor(
    readonly provider: string,
    readonly exhaustedUntil: number,
    readonly reason: string,
  ) {
    super(
      `${provider} is rate-limited until ${new Date(exhaustedUntil * 1000).toISOString()}: ${reason}`,
    );
    this.name = 'RateLimitGuardError';
  }
}

const DEFAULT_RATE_ROOT = join(homedir(), '.harness', 'rate_limits');
const DEFAULT_MAX_SLEEP_SECONDS = 10 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60 * 60;

export class RateLimitGuard {
  private readonly path: string;
  private readonly now: () => number;
  private readonly maxSleepSeconds: number;

  constructor(
    readonly provider: string,
    opts: RateLimitGuardOpts = {},
  ) {
    const root = opts.root ?? DEFAULT_RATE_ROOT;
    this.path = join(root, `${provider}.json`);
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.maxSleepSeconds = opts.maxSleepSeconds ?? DEFAULT_MAX_SLEEP_SECONDS;
  }

  async beforeRequest(signal?: AbortSignal): Promise<void> {
    const state = this.read();
    if (!state) return;
    const remaining = state.exhausted_until - this.now();
    if (remaining <= 0) return;
    if (remaining > this.maxSleepSeconds) {
      throw new RateLimitGuardError(this.provider, state.exhausted_until, state.reason);
    }
    await sleepSeconds(remaining, signal);
  }

  markRateLimited(headers?: HeaderLike, reason = 'rate limited'): RateLimitState {
    const now = this.now();
    const exhaustedUntil = resetTimeFromHeaders(headers, now) ?? now + DEFAULT_COOLDOWN_SECONDS;
    const state = { exhausted_until: exhaustedUntil, reason, detected_at: now };
    writeAtomic(this.path, state);
    return state;
  }

  read(): RateLimitState | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as RateLimitState;
    } catch {
      return null;
    }
  }
}

export function resetTimeFromHeaders(headers: HeaderLike | undefined, now: number): number | null {
  if (!headers) return null;
  const reset1h = parseResetHeader(getHeader(headers, 'x-ratelimit-reset-requests-1h'), now);
  if (reset1h !== null) return reset1h;
  const reset = parseResetHeader(getHeader(headers, 'x-ratelimit-reset-requests'), now);
  if (reset !== null) return reset;
  const retryAfter = parseRetryAfter(getHeader(headers, 'retry-after'), now);
  if (retryAfter !== null) return retryAfter;
  return null;
}

function getHeader(headers: HeaderLike, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v ?? null;
  }
  return null;
}

function parseResetHeader(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return numeric / 1000;
    if (numeric > 1_000_000_000) return numeric;
    return now + Math.max(0, numeric);
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date / 1000 : null;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? date / 1000 : null;
}

function writeAtomic(path: string, state: RateLimitState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

async function sleepSeconds(seconds: number, signal?: AbortSignal): Promise<void> {
  if (seconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted while waiting for provider rate-limit reset'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
