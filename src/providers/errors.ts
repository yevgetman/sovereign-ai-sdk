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
  if (err instanceof ProviderHttpError && err.status === 402) return true;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('credit balance is too low') ||
    lower.includes('insufficient quota') ||
    lower.includes('billing') ||
    lower.includes('purchase credits')
  );
}

export function isRateLimited(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status === 429;
}

export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof ProviderHttpError && err.status === 413) return true;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('context limit') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('maximum context') ||
    lower.includes('max context') ||
    lower.includes('prompt is too long') ||
    lower.includes('too many tokens')
  );
}
