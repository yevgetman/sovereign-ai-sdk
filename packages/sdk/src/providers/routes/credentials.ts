// Read-only credential inspection for a route (spec 2026-10-08 §5.1).
// Performs no refresh, login, browser, network call or credential write.
// Keychain reads are bounded; a platform failure or timeout is `unavailable`,
// never `missing`. Nothing secret is returned.

import type { Settings } from '../../config/schema.js';
import { SubscriptionAuthExpiredError } from '../errors.js';
import { apiKeyCredentialCount } from '../resolver.js';
import { KEYCHAIN_SERVICE } from '../subscription/names.js';
import type { SubscriptionCredentialPort, SubscriptionRecord } from '../subscription/port.js';
import type { RouteRecord } from './types.js';

export type CredentialState = 'missing' | 'present' | 'expired' | 'unreadable' | 'unavailable';

export type RouteCredentialStatus = {
  credentialState: CredentialState;
  /** True when a stored refresh token lets SOV renew access without a login. */
  refreshable: boolean;
};

export type InspectRouteCredentialOpts = {
  settings?: Settings;
  env?: NodeJS.ProcessEnv;
  /** Required for subscription routes. Tests inject a fake. */
  subscriptionPort?: SubscriptionCredentialPort;
  /** Bound on the Keychain read. Default 5 s. */
  timeoutMs?: number;
  now?: () => number;
};

export const DEFAULT_STATUS_TIMEOUT_MS = 5_000;

/** The external command that creates a subscription login for `route`. */
export function loginCommandFor(route: RouteRecord): string | undefined {
  return route.auth === 'subscription' ? `sov login ${route.provider}` : undefined;
}

export async function inspectRouteCredential(
  route: RouteRecord,
  opts: InspectRouteCredentialOpts = {},
): Promise<RouteCredentialStatus> {
  if (route.auth === 'api_key') {
    const count = apiKeyCredentialCount(route.provider, opts.settings ?? {}, opts.env ?? {});
    return { credentialState: count > 0 ? 'present' : 'missing', refreshable: false };
  }
  if (!opts.subscriptionPort) {
    return { credentialState: 'unavailable', refreshable: false };
  }
  const service = KEYCHAIN_SERVICE[route.provider as 'chatgpt' | 'grok'];
  const outcome = await boundedRead(
    opts.subscriptionPort,
    service,
    opts.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS,
  );
  if (outcome.kind === 'unreadable') return { credentialState: 'unreadable', refreshable: false };
  if (outcome.kind === 'unavailable') return { credentialState: 'unavailable', refreshable: false };
  const record = outcome.record;
  if (!record) return { credentialState: 'missing', refreshable: false };
  const refreshable = record.refreshToken.length > 0;
  const now = (opts.now ?? Date.now)();
  return { credentialState: record.expiresAt <= now ? 'expired' : 'present', refreshable };
}

type ReadOutcome =
  | { kind: 'record'; record: SubscriptionRecord | null }
  | { kind: 'unreadable' }
  | { kind: 'unavailable' };

async function boundedRead(
  port: SubscriptionCredentialPort,
  service: string,
  timeoutMs: number,
): Promise<ReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReadOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unavailable' }), timeoutMs);
  });
  const read = port.read(service).then(
    (record): ReadOutcome => ({ kind: 'record', record }),
    (err): ReadOutcome =>
      // The adapter reports a corrupt record as an (unreadable) expired login;
      // every other failure is the platform's, not the user's.
      err instanceof SubscriptionAuthExpiredError
        ? { kind: 'unreadable' }
        : { kind: 'unavailable' },
  );
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
