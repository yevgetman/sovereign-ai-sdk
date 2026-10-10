import { expect, test } from 'bun:test';
import { SessionSummaryEvent } from '../../src/server/schema.js';

test('session summary wire preserves incomplete pricing and legacy absence', () => {
  const base = {
    type: 'session_summary',
    seq: 1,
    sessionId: 'fixture',
    totalDispatched: 0,
    byAgent: {},
    tokens: { input: 1, output: 2, estimatedCostUsd: 0 },
  };
  expect(
    SessionSummaryEvent.parse({ ...base, tokens: { ...base.tokens, costComplete: false } }).tokens
      ?.costComplete,
  ).toBe(false);
  expect(SessionSummaryEvent.parse(base).tokens).not.toHaveProperty('costComplete');
});
