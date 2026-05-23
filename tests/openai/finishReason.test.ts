// Phase 18 H3 — pure-function unit test for `mapTerminalToFinishReason`.
//
// OpenAI's spec defines `finish_reason` as one of
// `'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call'`.
// Anything else makes SDK clients (openai-python, openai-js) raise a
// validation error during response parsing. The non-streaming branch
// previously returned `'error'` when the terminal reason was 'error',
// 'interrupted', or 'checkin' — none of which are valid.
//
// H3 collapses all non-length terminals to 'stop'. This file pins that
// contract so future refactors can't reintroduce a non-spec value.

import { describe, expect, test } from 'bun:test';
import type { Terminal } from '../../src/core/types.js';
import { mapTerminalToFinishReason } from '../../src/openai/routes/chatCompletions.js';

describe('mapTerminalToFinishReason (H3 — OpenAI spec compliance)', () => {
  test("'completed' → 'stop'", () => {
    expect(mapTerminalToFinishReason({ reason: 'completed' })).toBe('stop');
  });

  test("'max_tokens' → 'length'", () => {
    expect(mapTerminalToFinishReason({ reason: 'max_tokens' })).toBe('length');
  });

  test("'max_turns' → 'length'", () => {
    expect(mapTerminalToFinishReason({ reason: 'max_turns' })).toBe('length');
  });

  test("'error' collapses to 'stop' (not 'error' — non-spec)", () => {
    // The H2 fix short-circuits before this function in the route, but
    // the function stays defensive — any future caller that bypasses
    // the structured error envelope still produces a spec-valid value.
    const terminal: Terminal = { reason: 'error', error: new Error('boom') };
    expect(mapTerminalToFinishReason(terminal)).toBe('stop');
  });

  test("'interrupted' collapses to 'stop' (not 'error' — non-spec)", () => {
    expect(mapTerminalToFinishReason({ reason: 'interrupted' })).toBe('stop');
  });

  test("'checkin' collapses to 'stop' (not 'error' — non-spec)", () => {
    expect(mapTerminalToFinishReason({ reason: 'checkin' })).toBe('stop');
  });

  test("return type is restricted to 'stop' | 'length'", () => {
    // Static guarantee: TypeScript narrows the return to the spec subset
    // we surface. Any future addition to Terminal['reason'] requires an
    // explicit choice between the two valid values; the function will
    // not compile if a new reason needs another OpenAI finish_reason
    // value (e.g. 'content_filter') without an explicit branch.
    const result: 'stop' | 'length' = mapTerminalToFinishReason({ reason: 'completed' });
    expect(['stop', 'length']).toContain(result);
  });
});
