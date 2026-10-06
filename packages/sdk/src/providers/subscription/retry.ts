/** Retry timing for subscription model calls. API-key providers do not use this. */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isConnectionReset(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const code = (err as { code?: string }).code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return true;
  const message = err.message.toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed')
  );
}

/** Milliseconds to wait, or `'over-limit'` when the server asked for more than 10 seconds. */
export function retryAfterDelay(
  header: string | null,
  nowMs: number,
): number | 'over-limit' | null {
  if (header === null || header.trim().length === 0) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    if (seconds > 10) return 'over-limit';
    return Math.max(0, seconds * 1000);
  }
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  const delta = when - nowMs;
  if (delta > 10_000) return 'over-limit';
  return Math.max(0, delta);
}

/** First failure waits 500 ms. The next waits 1500 ms. Jitter is 0–250 ms. */
export function backoffMs(failureIndex: number, random: () => number): number {
  const base = failureIndex <= 0 ? 500 : 1500;
  const unit = random();
  const jitter = Math.floor((Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0) * 251);
  return base + Math.min(jitter, 250);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

const OVERFLOW_TEXT = [
  'context length',
  'context window',
  'context limit',
  'context_length_exceeded',
  'maximum context',
  'max context',
  'prompt is too long',
  'too many tokens',
];

export function looksLikeContextOverflow(status: number, body: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return OVERFLOW_TEXT.some((phrase) => lower.includes(phrase));
}
