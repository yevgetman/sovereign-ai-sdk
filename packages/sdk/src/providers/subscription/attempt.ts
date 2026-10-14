import {
  ContextOverflowError,
  CredentialStoreUnavailableError,
  CredentialUnavailableError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionTierBlockedError,
} from '../errors.js';
import { subscriptionDiagnostic } from './diagnostics.js';
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
      if (refreshedAfter401) {
        const body = await readFailureBody(response, opts.signal);
        throw new SubscriptionAuthExpiredError(
          opts.provider,
          undefined,
          subscriptionDiagnostic(response.status, body),
        );
      }
      await discard(response);
      refreshedAfter401 = true;
      await opts.refresh();
      attempt -= 1;
      continue;
    }

    if (opts.tierBlockedOn403 && response.status === 403) {
      const body = await readFailureBody(response, opts.signal);
      throw new SubscriptionTierBlockedError(
        opts.provider,
        undefined,
        subscriptionDiagnostic(response.status, body),
      );
    }

    if (response.status === 400 || response.status === 413) {
      const body = await readFailureBody(response, opts.signal);
      if (looksLikeContextOverflow(response.status, body)) {
        throw new ContextOverflowError(
          opts.provider,
          undefined,
          subscriptionDiagnostic(response.status, body),
        );
      }
      if (
        /model_not_found|invalid_model|unknown_model|model not found|model.*does not exist/i.test(
          body,
        )
      )
        throw httpFailure(opts.provider, 404, body, response.status);
      throw httpFailure(opts.provider, response.status, body);
    }

    if (isRetryableStatus(response.status)) {
      const delay = retryAfterDelay(response.headers.get('retry-after'), opts.deps.now());
      if (delay === 'over-limit' || attempt === 3) {
        const body = await readFailureBody(response, opts.signal);
        throw httpFailure(opts.provider, response.status, body);
      }
      await discard(response);
      await waitForRetry(opts, failureIndex, delay);
      failureIndex += 1;
      continue;
    }

    if (response.status >= 400) {
      const body = await readFailureBody(response, opts.signal);
      throw httpFailure(opts.provider, response.status, body);
    }

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

function httpFailure(
  provider: string,
  status: number,
  body?: string,
  upstreamStatus = status,
): Error {
  return new SubscriptionHttpError(
    provider,
    status,
    undefined,
    body === undefined ? undefined : subscriptionDiagnostic(upstreamStatus, body),
  );
}

function redactConnection(provider: string, err: unknown): Error {
  if (
    err instanceof SubscriptionAuthExpiredError ||
    err instanceof CredentialStoreUnavailableError ||
    err instanceof CredentialUnavailableError ||
    (err instanceof Error && err.name === 'RouteError')
  )
    return err;
  return new Error(`subscription provider ${provider} connection failed`);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Already consumed or closed. */
  }
}
async function readFailureBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError(signal);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < 16_384) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value.subarray(0, 16_384 - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    if (signal?.aborted) throw abortError(signal);
    return text;
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError'))
      throw abortError(signal);
    // A failed body read is still an HTTP failure; never expose its raw error.
    return '';
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
