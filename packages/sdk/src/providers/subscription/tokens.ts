import { SubscriptionAuthExpiredError } from '../errors.js';
import type { SubscriptionCredentialPort, SubscriptionRecord } from './port.js';

const REFRESH_SKEW_MS = 60_000;

const refreshTail = new Map<string, Promise<void>>();

/** One refresh at a time per Keychain service, so two turns cannot rotate one token. */
export async function withRefreshLock<T>(service: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshTail.get(service) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  refreshTail.set(service, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export type RefreshExchange = (current: SubscriptionRecord) => Promise<SubscriptionRecord>;

/**
 * Read the record. If it expires within 60 seconds, refresh once and write it back.
 * A failed refresh throws `SubscriptionAuthExpiredError` and does not try an API key.
 */
export async function loadFreshRecord(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  now: () => number,
  exchange: RefreshExchange,
): Promise<SubscriptionRecord> {
  const current = await port.read(service);
  if (!current) throw new SubscriptionAuthExpiredError(provider);
  if (current.expiresAt - now() > REFRESH_SKEW_MS) return current;
  return forceRefresh(provider, service, port, now, exchange);
}

/** Refresh even when the access token has not expired. Used after HTTP 401. */
export async function forceRefresh(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  now: () => number,
  exchange: RefreshExchange,
): Promise<SubscriptionRecord> {
  return withRefreshLock(service, async () => {
    const again = await port.read(service);
    if (!again) throw new SubscriptionAuthExpiredError(provider);
    // A concurrent turn may already have written a fresh token. The 401 path
    // uses exchangeUnderLock, which always exchanges.
    if (again.expiresAt - now() > REFRESH_SKEW_MS) return again;
    try {
      const next = await exchange(again);
      await port.write(service, next);
      return next;
    } catch (err) {
      if (err instanceof SubscriptionAuthExpiredError) throw err;
      throw new SubscriptionAuthExpiredError(provider);
    }
  });
}

/**
 * Mark the stored token as due so the next `forceRefresh` does not treat a
 * concurrent write of the SAME expiry as fresh. Callers that already know the
 * server rejected the access token pass the record through `exchange` directly.
 */
export async function exchangeUnderLock(
  provider: string,
  service: string,
  port: SubscriptionCredentialPort,
  exchange: RefreshExchange,
): Promise<SubscriptionRecord> {
  return withRefreshLock(service, async () => {
    const current = await port.read(service);
    if (!current) throw new SubscriptionAuthExpiredError(provider);
    try {
      const next = await exchange(current);
      await port.write(service, next);
      return next;
    } catch (err) {
      if (err instanceof SubscriptionAuthExpiredError) throw err;
      throw new SubscriptionAuthExpiredError(provider);
    }
  });
}
