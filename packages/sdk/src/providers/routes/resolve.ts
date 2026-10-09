// Resolve a built-in route to its provider (spec 2026-10-08 §4.1, §6).
//
// Always goes through `resolveProvider`, so API-key routes keep SOV's
// env/config precedence and credential pool. A route never switches provider
// or authentication kind: there is no fallback to another key, login, provider
// or model. Subscription routes opt in to subscription auth for the LOCAL OWNER
// only — a gateway `principal` is refused before the Keychain is read.

import { loadSettings } from '../../config/loader.js';
import type { Settings } from '../../config/schema.js';
import type { ReasoningEffort } from '../effort.js';
import { CredentialUnavailableError } from '../errors.js';
import { type ResolveProviderOpts, type ResolvedProvider, resolveProvider } from '../resolver.js';
import { macKeychainPort } from '../subscription/keychain.js';
import type { LLMProvider } from '../types.js';
import { getRoute } from './catalog.js';
import { inspectRouteCredential, loginCommandFor } from './credentials.js';
import { RouteError, routeErrorCodeFor } from './errors.js';
import type { RouteRecord } from './types.js';
import { validateRouteSelection } from './validate.js';

export type ResolveRouteOpts = Omit<ResolveProviderOpts, 'allowSubscriptionAuth' | 'settings'> & {
  settings?: Settings;
  /** Requested model; `auto` or absent selects the route default. */
  model?: string;
  /** Requested effort; `auto` or absent selects the route default. */
  effort?: string;
  /** Bound on the pre-inference Keychain presence check. */
  credentialTimeoutMs?: number;
};

export type RouteResolution = {
  route: RouteRecord;
  model: string;
  effort: ReasoningEffort;
  /** The provider for the agent loop. Bound to the route's provider and auth. */
  provider: LLMProvider;
  resolved: ResolvedProvider;
};

/**
 * Validate the route + selection, confirm a local credential exists, and
 * build the provider. Failures throw `RouteError` with a stable code:
 * `route_unavailable`, `model_unsupported`, `effort_unsupported`,
 * `credential_missing`, `credential_unavailable` or `auth_expired`.
 */
export async function resolveRouteProvider(
  routeId: string,
  opts: ResolveRouteOpts = {},
): Promise<RouteResolution> {
  const env = opts.env ?? process.env;
  const settings = opts.settings ?? loadSettings({ env });
  const route = getRoute(routeId, settings);
  if (!route.enabled) {
    throw new RouteError('route_unavailable', `route ${route.id} is disabled`, {
      routeId: route.id,
    });
  }
  const selection = validateRouteSelection(route, {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  });
  const subscription = route.auth === 'subscription';
  if (subscription && opts.principal !== undefined) {
    throw new RouteError(
      'route_unavailable',
      `route ${route.id} is not available to a gateway principal`,
      { routeId: route.id },
    );
  }
  const subscriptionPort = subscription ? (opts.subscriptionPort ?? macKeychainPort()) : undefined;
  await assertCredentialUsable(route, {
    settings,
    env,
    ...(subscriptionPort ? { subscriptionPort } : {}),
    ...(opts.credentialTimeoutMs !== undefined ? { timeoutMs: opts.credentialTimeoutMs } : {}),
  });

  const { model: _model, effort: _effort, credentialTimeoutMs: _timeout, ...rest } = opts;
  let resolved: ResolvedProvider;
  try {
    resolved = resolveProvider(route.provider, selection.model, {
      ...rest,
      env,
      settings,
      allowSubscriptionAuth: subscription,
      ...(subscriptionPort ? { subscriptionPort } : {}),
    });
  } catch (err) {
    throw toRouteError(route, err);
  }
  if (resolved.metadata.provider !== route.provider) {
    throw new RouteError('route_unavailable', `route ${route.id} resolved to another provider`, {
      routeId: route.id,
    });
  }
  return {
    route,
    model: selection.model,
    effort: selection.effort,
    provider: resolved.transport,
    resolved,
  };
}

async function assertCredentialUsable(
  route: RouteRecord,
  opts: Parameters<typeof inspectRouteCredential>[1],
): Promise<void> {
  const status = await inspectRouteCredential(route, opts);
  const login = loginCommandFor(route);
  switch (status.credentialState) {
    case 'present':
      return;
    case 'expired':
      if (status.refreshable) return;
      throw new RouteError(
        'auth_expired',
        `${route.provider} login expired${login ? `; run \`${login}\`` : ''}`,
        { routeId: route.id },
      );
    case 'unreadable':
      throw new RouteError(
        'auth_expired',
        `${route.provider} login is unreadable${login ? `; run \`${login}\`` : ''}`,
        { routeId: route.id },
      );
    case 'unavailable':
      throw new RouteError(
        'credential_unavailable',
        `the credential store for ${route.id} is unavailable`,
        { routeId: route.id },
      );
    case 'missing':
      throw new RouteError(
        'credential_missing',
        login
          ? `no ${route.provider} login; run \`${login}\``
          : `no API key configured for ${route.provider}`,
        { routeId: route.id },
      );
  }
}

function toRouteError(route: RouteRecord, err: unknown): RouteError {
  if (err instanceof RouteError) return err;
  const code =
    err instanceof CredentialUnavailableError ? 'credential_missing' : routeErrorCodeFor(err);
  const message = err instanceof Error ? err.message : `route ${route.id} failed to resolve`;
  return new RouteError(code, message, { routeId: route.id, cause: err });
}
