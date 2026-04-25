// Provider error types and classifiers shared by resolver, transports, and
// auxiliary fallback. Keeping these typed avoids string-matching above the
// provider layer.

import type { HeaderLike } from './credentials/rateGuard.js';

export class CredentialUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message = `no usable credential for provider ${provider}`,
  ) {
    super(message);
    this.name = 'CredentialUnavailableError';
  }
}

export class BillingExhaustedError extends Error {
  constructor(
    readonly provider: string,
    message = `billing exhausted for provider ${provider}`,
  ) {
    super(message);
    this.name = 'BillingExhaustedError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly headers?: HeaderLike,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export class NoAuxiliaryAvailableError extends Error {
  constructor(readonly purpose: string) {
    super(`no auxiliary provider available for ${purpose}`);
    this.name = 'NoAuxiliaryAvailableError';
  }
}

export function isCredentialUnavailable(err: unknown): boolean {
  if (err instanceof CredentialUnavailableError) return true;
  if (err instanceof ProviderHttpError) return err.status === 401 || err.status === 403;
  return false;
}

export function isBillingExhausted(err: unknown): boolean {
  if (err instanceof BillingExhaustedError) return true;
  if (err instanceof ProviderHttpError) return err.status === 402;
  return false;
}

export function isRateLimited(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status === 429;
}
