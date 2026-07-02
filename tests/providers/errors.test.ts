// Pins the substring matchers in src/providers/errors.ts against the real
// error-message shapes we have observed from live providers.
//
// Sources documented inline. The Anthropic shape was captured on 2026-05-15
// (backlog #35) by sending a 330K-token user message to claude-haiku-4-5.

import { describe, expect, test } from 'bun:test';
import {
  ProviderHttpError,
  isBillingExhausted,
  isContextOverflowError,
  isModelUnavailable,
  isRateLimited,
} from '@yevgetman/sov-sdk/providers/errors';

describe('isContextOverflowError', () => {
  // Verified via live probe (2026-05-15) — backlog #35.
  test('matches real Anthropic SDK BadRequestError message format', () => {
    const realAnthropicMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200039 tokens > 200000 maximum"},"request_id":"req_011Cb4PSe4i4X232iyFFhWLt"}';
    const err = new Error(realAnthropicMessage);
    expect(isContextOverflowError(err)).toBe(true);
  });

  test('matches synthetic test fixture ("context length exceeded by N tokens")', () => {
    const err = new Error('context length exceeded by 12000 tokens');
    expect(isContextOverflowError(err)).toBe(true);
  });

  test('matches OpenAI-style context_length_exceeded code', () => {
    const err = new Error(
      "This model's maximum context length is 128000 tokens, however you requested 200000 tokens (context_length_exceeded).",
    );
    expect(isContextOverflowError(err)).toBe(true);
  });

  test('treats HTTP 413 as overflow regardless of message', () => {
    const err = new ProviderHttpError('anthropic', 413, 'payload too large');
    expect(isContextOverflowError(err)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflowError(new Error('unauthorized'))).toBe(false);
    expect(isContextOverflowError('not even an Error')).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

describe('isRateLimited', () => {
  test('returns true for ProviderHttpError 429', () => {
    expect(isRateLimited(new ProviderHttpError('anthropic', 429, 'rate limit'))).toBe(true);
  });

  test('returns false for other statuses', () => {
    expect(isRateLimited(new ProviderHttpError('anthropic', 400, 'bad request'))).toBe(false);
    expect(isRateLimited(new Error('plain error'))).toBe(false);
  });
});

describe('isBillingExhausted', () => {
  test('matches Anthropic credit-exhausted message', () => {
    expect(isBillingExhausted(new Error('Your credit balance is too low to access the API.'))).toBe(
      true,
    );
  });

  test('matches OpenAI insufficient_quota', () => {
    expect(
      isBillingExhausted(new Error('You exceeded your current quota (insufficient quota).')),
    ).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isBillingExhausted(new Error('rate limited'))).toBe(false);
  });
});

describe('isModelUnavailable', () => {
  test('matches Ollama "try pulling it first" message', () => {
    expect(isModelUnavailable(new Error('model not found, try pulling it first'))).toBe(true);
  });

  test('returns true for ProviderHttpError 404', () => {
    expect(isModelUnavailable(new ProviderHttpError('openai', 404, 'not found'))).toBe(true);
  });
});
