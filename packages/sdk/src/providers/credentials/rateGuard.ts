// Cross-session rate-limit guard. A 429 in one process writes a shared JSON
// sentinel so other sessions pause or fail fast instead of amplifying retries.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveHarnessHome } from '../../config/paths.js';
import { SECURE_FILE_MODE, chmodSafe, secureMkdir } from '../../util/secureFs.js';

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

const DEFAULT_MAX_SLEEP_SECONDS = 10 * 60;
/** No-header 429 backoff floor. A header-less 429 must NOT lock the provider
 *  for a full hour across every session; start small and grow on repeats. */
const NO_HEADER_BASE_COOLDOWN_SECONDS = 60;
/** Ceiling for the grown no-header backoff — kept well under an hour so a
 *  burst of header-less 429s can't silently brick the provider. */
const NO_HEADER_MAX_COOLDOWN_SECONDS = 15 * 60;

/** Profile-aware default — resolves at construction time so profile-scoped
 *  rate-limit state lands under the right HARNESS_HOME (Phase 10.7). */
function defaultRateRoot(): string {
  return join(resolveHarnessHome(), 'rate_limits');
}

export class RateLimitGuard {
  private readonly path: string;
  private readonly now: () => number;
  private readonly maxSleepSeconds: number;

  constructor(
    readonly provider: string,
    opts: RateLimitGuardOpts = {},
  ) {
    const root = opts.root ?? defaultRateRoot();
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
    const fromHeaders = resetTimeFromHeaders(headers, now);
    const exhaustedUntil = fromHeaders ?? now + this.noHeaderCooldownSeconds(now);
    const state = { exhausted_until: exhaustedUntil, reason, detected_at: now };
    writeAtomic(this.path, state);
    return state;
  }

  /** No-header backoff: start at the base floor; if a prior no-header cooldown
   *  is still in effect (an immediate repeat 429), double the previous delay,
   *  capped under an hour. Conservative — never under-waits a real limit. */
  private noHeaderCooldownSeconds(now: number): number {
    const prior = this.read();
    if (prior && prior.exhausted_until > now) {
      const priorDelay = prior.exhausted_until - prior.detected_at;
      const grown = Math.max(priorDelay * 2, NO_HEADER_BASE_COOLDOWN_SECONDS);
      return Math.min(grown, NO_HEADER_MAX_COOLDOWN_SECONDS);
    }
    return NO_HEADER_BASE_COOLDOWN_SECONDS;
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
  // OpenRouter (and others) emit a generic X-RateLimit-Reset. parseResetHeader
  // already disambiguates epoch-ms / epoch-s / relative-seconds by magnitude.
  const genericReset = parseResetHeader(getHeader(headers, 'x-ratelimit-reset'), now);
  if (genericReset !== null) return genericReset;
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
  // OpenAI emits native reset headers as Go-duration strings ('6m0s', '1.5s',
  // '880ms', '1h2m3s'); without this they'd fall through to the 60s floor.
  const durationSeconds = parseGoDurationSeconds(trimmed);
  if (durationSeconds !== null) return now + Math.max(0, durationSeconds);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date / 1000 : null;
}

const GO_DURATION_UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  // U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU — both used by Go.
  µs: 1e-6,
  μs: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};
// Longest units first so 'ms'/'us'/'ns' match before the bare 's'.
const GO_DURATION_SEGMENT_RE = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/giy;

/** Parse a Go time.Duration string (e.g. '6m0s', '1.5s', '880ms', '1h2m3s')
 *  to seconds. Returns null when the value is not a well-formed, fully-consumed
 *  duration so callers can fall through to other formats. */
function parseGoDurationSeconds(value: string): number | null {
  const body = value.startsWith('-') || value.startsWith('+') ? value.slice(1) : value;
  if (body.length === 0) return null;
  GO_DURATION_SEGMENT_RE.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let match = GO_DURATION_SEGMENT_RE.exec(body);
  while (match !== null) {
    const amount = Number(match[1]);
    const unitSeconds = GO_DURATION_UNIT_SECONDS[match[2] ?? ''];
    if (!Number.isFinite(amount) || unitSeconds === undefined) return null;
    total += amount * unitSeconds;
    consumed = GO_DURATION_SEGMENT_RE.lastIndex;
    match = GO_DURATION_SEGMENT_RE.exec(body);
  }
  // Reject anything not fully consumed by valid segments (e.g. trailing junk).
  if (consumed !== body.length) return null;
  return value.startsWith('-') ? -total : total;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? date / 1000 : null;
}

function writeAtomic(path: string, state: RateLimitState): void {
  // Keep the whole state root uniform (audit F10): dir 0700, file 0600. The tmp
  // file's 0600 mode survives the atomic rename onto `path`.
  secureMkdir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECURE_FILE_MODE,
  });
  chmodSafe(tmp, SECURE_FILE_MODE);
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
