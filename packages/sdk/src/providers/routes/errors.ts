// Stable route error codes (spec 2026-10-08 §5.3) and the mapper from provider
// errors to them. The SDK host reports `turn.error.code` from `routeErrorCodeFor`.
// Messages are safe: they never carry keys, tokens or account identity.

import {
  ClaudeMaxTermsError,
  ContextOverflowError,
  CredentialStoreUnavailableError,
  CredentialUnavailableError,
  PersistBeforeRunError,
  ProviderHttpError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionLoginMissingError,
  SubscriptionTierBlockedError,
  UnknownToolsetError,
  isContextOverflowError,
  isModelUnavailable,
} from '../errors.js';

/** Every stable error code a machine request may end with. */
export const ROUTE_ERROR_CODES = [
  'invalid_input',
  'route_unavailable',
  'model_unsupported',
  'effort_unsupported',
  'credential_missing',
  'auth_expired',
  'credential_unavailable',
  'tier_blocked',
  'rate_limited',
  'context_overflow',
  'unsupported_input',
  'interrupted',
  'storage_failed',
  'provider_failed',
] as const;

export type RouteErrorCode = (typeof ROUTE_ERROR_CODES)[number];

/** A typed route failure. `code` is stable; `message` is safe to show. */
export class RouteError extends Error {
  readonly code: RouteErrorCode;
  readonly routeId: string | undefined;

  constructor(
    code: RouteErrorCode,
    message: string,
    opts: { routeId?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RouteError';
    this.code = code;
    this.routeId = opts.routeId;
  }
}

export function isRouteErrorCode(value: string): value is RouteErrorCode {
  return (ROUTE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Map any error from route resolution, credential handling or inference to a
 * stable code. Order matters: subclasses before their parents, typed errors
 * before message heuristics. Unknown failures are `provider_failed`.
 */
export function routeErrorCodeFor(err: unknown): RouteErrorCode {
  if (err instanceof RouteError) return err.code;
  if (isAbort(err)) return 'interrupted';
  if (err instanceof SubscriptionLoginMissingError) return 'credential_missing';
  if (err instanceof SubscriptionTierBlockedError) return 'tier_blocked';
  if (err instanceof SubscriptionAuthExpiredError) return 'auth_expired';
  if (err instanceof CredentialStoreUnavailableError) return 'credential_unavailable';
  if (err instanceof ClaudeMaxTermsError) return 'route_unavailable';
  if (err instanceof CredentialUnavailableError) return 'credential_missing';
  if (err instanceof PersistBeforeRunError) return 'storage_failed';
  if (err instanceof UnknownToolsetError) return 'invalid_input';
  if (err instanceof ContextOverflowError || isContextOverflowError(err)) return 'context_overflow';
  if (err instanceof SubscriptionHttpError) return codeForStatus(err.status);
  if (isModelUnavailable(err)) return 'model_unsupported';
  if (err instanceof ProviderHttpError) return codeForStatus(err.status);
  const status = statusOf(err);
  if (status !== undefined) return codeForStatus(status);
  return 'provider_failed';
}

function codeForStatus(status: number): RouteErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth_expired';
  if (status === 404) return 'model_unsupported';
  if (status === 413) return 'context_overflow';
  return 'provider_failed';
}

/** Vendor SDK errors (Anthropic/OpenAI clients) carry a numeric `status`. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}
