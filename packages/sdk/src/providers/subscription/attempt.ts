import type { AssistantMessage, StreamEvent } from '../../core/types.js';
import {
  ContextOverflowError,
  CredentialStoreUnavailableError,
  CredentialUnavailableError,
  ProviderHttpError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionRefreshError,
  SubscriptionStreamError,
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
type AttemptOptions = {
  provider: string;
  signal?: AbortSignal;
  /** Grok only. HTTP 403 ends the turn and does not send another request. */
  tierBlockedOn403: boolean;
  deps: AttemptDeps;
  send: () => Promise<Response>;
  refresh: () => Promise<void>;
};

type AttemptState = { sent: number; failureIndex: number; refreshedAfter401: boolean };
const newAttemptState = (): AttemptState => ({
  sent: 0,
  failureIndex: 0,
  refreshedAfter401: false,
});

/** HTTP-only helper retained for callers that do not consume Responses streams. */
export function subscriptionAttempt(opts: AttemptOptions): Promise<Response> {
  return requestAttempt(opts, newAttemptState());
}

/** One budget covers connection, HTTP status and pre-delivery stream failures. */
export async function* subscriptionStreamAttempt(
  opts: AttemptOptions & {
    translate: (
      response: Response,
      onSemantic: () => void,
    ) => AsyncGenerator<StreamEvent, AssistantMessage>;
  },
): AsyncGenerator<StreamEvent, AssistantMessage> {
  const state = newAttemptState();
  let started = false;
  while (state.sent < 3) {
    const response = await requestAttempt(opts, state);
    let delivered = false;
    let retryDelay: number | null = null;
    const stream = opts.translate(response, () => {
      delivered = true;
    });
    try {
      while (true) {
        const step = await stream.next();
        if (step.done) return step.value;
        if (step.value.type === 'message_start') {
          if (started) continue;
          started = true;
        } else delivered = true;
        yield step.value;
      }
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err instanceof Error ? err : abortError(opts.signal);
      }
      if (
        err instanceof ContextOverflowError ||
        (err instanceof Error && err.name === 'RouteError')
      )
        throw err;
      const failure =
        err instanceof SubscriptionStreamError
          ? err
          : new SubscriptionStreamError(
              opts.provider,
              delivered ? 'incomplete_delivery' : 'before_delivery',
              err instanceof ProviderHttpError
                ? err.message === 'subscription reasoning output order unavailable'
                  ? 'reasoning_order_unavailable'
                  : 'provider_failure'
                : 'invalid_event',
              !delivered && err instanceof ProviderHttpError && isRetryableStatus(err.status),
              err instanceof ProviderHttpError ? err.status : undefined,
            );
      const safe =
        delivered && failure.phase === 'before_delivery'
          ? new SubscriptionStreamError(
              opts.provider,
              'incomplete_delivery',
              failure.reason,
              false,
              failure.status,
            )
          : failure;
      if (delivered || safe.phase !== 'before_delivery' || !safe.retryable || state.sent >= 3)
        throw safe;
      const delay = retryAfterDelay(response.headers.get('retry-after'), opts.deps.now());
      if (delay === 'over-limit') throw safe;
      retryDelay = delay;
    } finally {
      // return() runs the translator's reader cleanup before another request.
      await stream.return(undefined as never).catch(() => {});
      await discard(response);
    }
    await waitForRetry(opts, state.failureIndex++, retryDelay);
  }
  throw new SubscriptionStreamError(opts.provider, 'before_delivery', 'premature_eof', false);
}

async function requestAttempt(opts: AttemptOptions, state: AttemptState): Promise<Response> {
  while (state.sent < 3) {
    state.sent += 1;
    if (opts.signal?.aborted) throw abortError(opts.signal);
    let response: Response;
    try {
      response = await opts.send();
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err instanceof Error ? err : abortError(opts.signal);
      }
      if (!isConnectionReset(err) || state.sent === 3) throw redactConnection(opts.provider, err);
      await waitForRetry(opts, state.failureIndex, null);
      state.failureIndex += 1;
      continue;
    }

    if (response.status === 401) {
      if (state.refreshedAfter401 || state.sent === 3) {
        const body = await readFailureBody(response, opts.signal);
        // An inference 401 is not proof that the refresh grant was revoked.
        throw httpFailure(opts.provider, response.status, body);
      }
      await discard(response);
      state.refreshedAfter401 = true;
      await opts.refresh();
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
      if (delay === 'over-limit' || state.sent === 3) {
        const body = await readFailureBody(response, opts.signal);
        throw httpFailure(opts.provider, response.status, body);
      }
      await discard(response);
      await waitForRetry(opts, state.failureIndex, delay);
      state.failureIndex += 1;
      continue;
    }

    if (response.status >= 400) {
      const body = await readFailureBody(response, opts.signal);
      throw httpFailure(opts.provider, response.status, body);
    }

    const declaredEmpty = response.headers.get('content-length') === '0';
    if (!response.body || declaredEmpty) {
      await discard(response);
      if (state.sent === 3) {
        throw new SubscriptionStreamError(opts.provider, 'before_delivery', 'premature_eof', true);
      }
      const delay = retryAfterDelay(response.headers.get('retry-after'), opts.deps.now());
      if (delay === 'over-limit')
        throw new SubscriptionStreamError(opts.provider, 'before_delivery', 'premature_eof', true);
      await waitForRetry(opts, state.failureIndex, delay);
      state.failureIndex += 1;
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
    err instanceof SubscriptionRefreshError ||
    err instanceof SubscriptionAuthExpiredError ||
    err instanceof CredentialStoreUnavailableError ||
    err instanceof CredentialUnavailableError ||
    (err instanceof Error && err.name === 'RouteError')
  )
    return err;
  return new SubscriptionStreamError(
    provider,
    'before_delivery',
    'connection_reset',
    isConnectionReset(err),
  );
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
