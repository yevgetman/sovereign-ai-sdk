// Token refresh has its own three-attempt budget inside the shared 20s deadline.
// Error payloads are inspected only for the standard invalid_grant proof, then
// discarded. They must never be copied into errors, traces or credential data.
import { SubscriptionAuthExpiredError, SubscriptionRefreshError } from '../errors.js';
import type { AttemptDeps } from './attempt.js';
import { recordFromTokenJson } from './oauth.js';
import type { SubscriptionRecord } from './port.js';
import { abortError, backoffMs, retryAfterDelay } from './retry.js';

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
export async function refreshTokenExchange(opts: {
  provider: string;
  previousRefresh: string;
  send: () => Promise<Response>;
  deps: AttemptDeps;
  signal?: AbortSignal;
}): Promise<SubscriptionRecord> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    try {
      let response: Response;
      try {
        response = await opts.send();
      } catch (err) {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        if (err instanceof Error && err.name === 'TimeoutError')
          throw new SubscriptionRefreshError(opts.provider, 'timeout');
        throw new SubscriptionRefreshError(opts.provider, 'connection_failure', true);
      }
      if (response.status === 429 || response.status >= 500) {
        const delay = retryAfterDelay(response.headers.get('retry-after'), opts.deps.now());
        // Cancel before waiting; retain no response body or transport error.
        await response.body?.cancel().catch(() => {});
        throw new SubscriptionRefreshError(
          opts.provider,
          response.status === 429 ? 'rate_limited' : 'provider_unavailable',
          delay !== 'over-limit',
          response.status,
          typeof delay === 'number' ? delay : undefined,
        );
      }
      const body = await tokenJson(response, opts.provider);
      if (!response.ok) {
        if (
          (response.status === 400 || response.status === 401) &&
          body &&
          typeof body === 'object' &&
          (body as Record<string, unknown>).error === 'invalid_grant'
        )
          throw new SubscriptionAuthExpiredError(opts.provider);
        throw new SubscriptionRefreshError(
          opts.provider,
          'request_rejected',
          false,
          response.status,
        );
      }
      if (opts.signal?.aborted) throw abortError(opts.signal);
      try {
        const record = recordFromTokenJson(
          opts.provider,
          body,
          opts.deps.now(),
          opts.previousRefresh,
        );
        if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= opts.deps.now())
          throw new Error('invalid token expiry');
        return record;
      } catch {
        throw new SubscriptionRefreshError(opts.provider, 'malformed_response');
      }
    } catch (err) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      if (!(err instanceof SubscriptionRefreshError) || !err.retryable || attempt === 2) throw err;
      await opts.deps.sleep(err.retryAfterMs ?? backoffMs(attempt, opts.deps.random), opts.signal);
    }
  }
  throw new SubscriptionRefreshError(opts.provider, 'provider_unavailable');
}

async function tokenJson(response: Response, provider: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SubscriptionRefreshError(provider, 'malformed_response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > MAX_TOKEN_RESPONSE_BYTES)
        throw new SubscriptionRefreshError(provider, 'malformed_response');
      chunks.push(step.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      throw new SubscriptionRefreshError(provider, 'malformed_response');
    }
  } catch (err) {
    if (err instanceof SubscriptionRefreshError) throw err;
    throw new SubscriptionRefreshError(provider, 'connection_failure', true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
