import { CredentialStoreUnavailableError, SubscriptionAuthExpiredError } from '../errors.js';
import { type LockOptions, advanceCredentialGeneration, withCredentialLock } from './lock.js';
import type { SubscriptionCredentialPort, SubscriptionRecord } from './port.js';
import { abortError } from './retry.js';

const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 20_000;
export type RefreshExchange = (
  current: SubscriptionRecord,
  signal?: AbortSignal,
) => Promise<SubscriptionRecord>;

/** Compatibility helper; production operations pass their credential identity. */
export function withRefreshLock<T>(
  service: string,
  fn: () => Promise<T>,
  port: SubscriptionCredentialPort = {
    async read() {
      return null;
    },
    async write() {},
    async delete() {},
  },
  opts: LockOptions = {},
): Promise<T> {
  return withCredentialLock(service, port, fn, opts);
}

export async function loadFreshRecord(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  now: () => number,
  exchange: RefreshExchange,
  opts: LockOptions = {},
): Promise<SubscriptionRecord> {
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const current = await port.read(service);
  if (!current) throw new SubscriptionAuthExpiredError(provider);
  if (current.expiresAt - now() > REFRESH_SKEW_MS) return current;
  return forceRefresh(provider, service, port, now, exchange, opts);
}

export function forceRefresh(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  now: () => number,
  exchange: RefreshExchange,
  opts: LockOptions = {},
): Promise<SubscriptionRecord> {
  return withCredentialLock(
    service,
    port,
    async () => {
      const current = await port.read(service);
      if (!current) throw new SubscriptionAuthExpiredError(provider);
      if (current.expiresAt - now() > REFRESH_SKEW_MS) return current;
      return exchangeAndSave(provider, service, port, current, exchange, opts.signal);
    },
    opts,
  );
}

/** A 401 only refreshes the exact generation rejected by the backend. */
export function exchangeUnderLock(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  exchange: RefreshExchange,
  rejected?: SubscriptionRecord,
  opts: LockOptions = {},
): Promise<SubscriptionRecord> {
  return withCredentialLock(
    service,
    port,
    async () => {
      const current = await port.read(service);
      if (!current) throw new SubscriptionAuthExpiredError(provider);
      if (
        rejected &&
        (current.accessToken !== rejected.accessToken ||
          current.refreshToken !== rejected.refreshToken ||
          current.expiresAt !== rejected.expiresAt)
      )
        return current;
      return exchangeAndSave(provider, service, port, current, exchange, opts.signal);
    },
    opts,
  );
}

async function exchangeAndSave(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  current: SubscriptionRecord,
  exchange: RefreshExchange,
  signal?: AbortSignal,
): Promise<SubscriptionRecord> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(abortError(signal));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new CredentialStoreUnavailableError(provider, 'refresh_timeout'));
    }, REFRESH_TIMEOUT_MS);
  });
  let next: SubscriptionRecord;
  try {
    next = await Promise.race([exchange(current, controller.signal), cancelled]);
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (
      err instanceof CredentialStoreUnavailableError ||
      err instanceof SubscriptionAuthExpiredError
    )
      throw err;
    throw new SubscriptionAuthExpiredError(provider);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw abortError(signal);
  // Writes stay inside the mutex. A write failure is storage failure, not a
  // successful refresh; never send inference using the unpersisted token.
  await advanceCredentialGeneration(port, service);
  await port.write(service, next);
  return next;
}
