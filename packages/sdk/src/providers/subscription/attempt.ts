import {
  ContextOverflowError,
  SubscriptionAuthExpiredError,
  SubscriptionTierBlockedError,
} from '../errors.js';
import {
  abortError,
  backoffMs,
  isConnectionReset,
  isRetryableStatus,
  looksLikeContextOverflow,
  retryAfterDelay,
  sleep,
} from './retry.js';

export type AttemptDeps = {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
};

export const defaultAttemptDeps: AttemptDeps = {
  sleep,
  random: () => Math.random(),
  now: () => Date.now(),
};

/**
 * Run the model HTTP call with subscription retry rules.
 * `send` performs one request with the current access token.
 * `refresh` runs the single 401 recovery. A second 401 throws.
 */
export async function subscriptionAttempt(opts: {
  provider: string;
  signal?: AbortSignal;
  /** Grok only. HTTP 403 ends the turn and does not send another request. */
  tierBlockedOn403: boolean;
  deps: AttemptDeps;
  send: () => Promise<Response>;
  refresh: () => Promise<void>;
}): Promise<Response> {
  let refreshedAfter401 = false;
  let failureIndex = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    let response: Response;
    try {
      response = await opts.send();
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err instanceof Error ? err : abortError(opts.signal);
      }
      if (!isConnectionReset(err) || attempt === 3) throw redactConnection(opts.provider, err);
      await waitForRetry(opts, failureIndex, null);
      failureIndex += 1;
      continue;
    }

    if (response.status === 401) {
      if (refreshedAfter401) throw new SubscriptionAuthExpiredError(opts.provider);
      refreshedAfter401 = true;
      await opts.refresh();
      attempt -= 1;
      continue;
    }

    if (opts.tierBlockedOn403 && response.status === 403) {
      throw new SubscriptionTierBlockedError(opts.provider);
    }

    if (response.status === 400 || response.status === 413) {
      const body = await response.text();
      if (looksLikeContextOverflow(response.status, body)) {
        throw new ContextOverflowError(opts.provider);
      }
      throw httpFailure(opts.provider, response.status);
    }

    if (isRetryableStatus(response.status)) {
      const delay = retryAfterDelay(response.headers.get('retry-after'), opts.deps.now());
      if (delay === 'over-limit' || attempt === 3)
        throw httpFailure(opts.provider, response.status);
      await waitForRetry(opts, failureIndex, delay);
      failureIndex += 1;
      continue;
    }

    if (response.status >= 400) throw httpFailure(opts.provider, response.status);

    const declaredEmpty = response.headers.get('content-length') === '0';
    if (!response.body || declaredEmpty) {
      if (attempt === 3) {
        throw new Error(`subscription provider ${opts.provider} returned an empty stream`);
      }
      await waitForRetry(opts, failureIndex, null);
      failureIndex += 1;
      continue;
    }

    return response;
  }

  throw new Error(`subscription provider ${opts.provider} failed`);
}

async function waitForRetry(
  opts: { signal?: AbortSignal; deps: AttemptDeps },
  failureIndex: number,
  retryAfter: number | null,
): Promise<void> {
  const ms = retryAfter === null ? backoffMs(failureIndex, opts.deps.random) : retryAfter;
  try {
    await opts.deps.sleep(ms, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err instanceof Error ? err : abortError(opts.signal);
    }
    throw err;
  }
}

function httpFailure(provider: string, status: number): Error {
  return new Error(`subscription provider ${provider} failed with HTTP ${status}`);
}

function redactConnection(provider: string, err: unknown): Error {
  if (err instanceof SubscriptionAuthExpiredError) return err;
  return new Error(`subscription provider ${provider} connection failed`);
}
