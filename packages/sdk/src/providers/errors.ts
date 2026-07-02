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

export function isModelUnavailable(err: unknown): boolean {
  if (err instanceof ProviderHttpError && err.status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('model not found') ||
    lower.includes("model '") ||
    lower.includes('not_found') ||
    lower.includes('try pulling it first')
  );
}

export function isRateLimited(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status === 429;
}

/**
 * Returns true when the error indicates the request exceeded the model's
 * context window.
 *
 * Verified against (2026-05-15, backlog #35) by sending a ~330K-token user
 * message to claude-haiku-4-5-20251001:
 * - @anthropic-ai/sdk@^0.90.0 surfaces overflows as `BadRequestError`
 *   (extends `AnthropicError extends Error`) with `err.status = 400`,
 *   `err.type = 'invalid_request_error'`, and `err.message` of the form:
 *   `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200039 tokens > 200000 maximum"},"request_id":"..."}`.
 *   The `'prompt is too long'` substring (lowercased) catches this.
 *
 * Synthetic test fixtures (tests/helpers/transportWrappers.ts) use
 * 'context length exceeded by N tokens'.
 */
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
