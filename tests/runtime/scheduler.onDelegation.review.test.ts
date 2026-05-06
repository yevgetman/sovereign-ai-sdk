// Phase 13.3 — recursion guard for review-fork notification in scheduler.
// Tests the helper that prevents infinite loops when review-* agents
// complete (their completion would re-fire onChildCompletion → infinite loop).

import { describe, expect, test } from 'bun:test';
import { shouldFireReviewOnDelegation } from '../../src/runtime/scheduler.js';

describe('shouldFireReviewOnDelegation — recursion guard', () => {
  test('returns true for non-review agents that completed', () => {
    expect(shouldFireReviewOnDelegation('explore', 'completed')).toBe(true);
    expect(shouldFireReviewOnDelegation('plan', 'completed')).toBe(true);
    expect(shouldFireReviewOnDelegation('verify', 'max_turns')).toBe(true);
    expect(shouldFireReviewOnDelegation('explore', 'max_turns')).toBe(true);
  });

  test('returns false for review agents (prevents recursion)', () => {
    expect(shouldFireReviewOnDelegation('review-memory', 'completed')).toBe(false);
    expect(shouldFireReviewOnDelegation('review-skill', 'completed')).toBe(false);
    expect(shouldFireReviewOnDelegation('review-consolidate', 'max_turns')).toBe(false);
  });

  test('returns false for non-success terminal reasons', () => {
    expect(shouldFireReviewOnDelegation('explore', 'error')).toBe(false);
    expect(shouldFireReviewOnDelegation('explore', 'interrupted')).toBe(false);
    expect(shouldFireReviewOnDelegation('explore', 'max_tokens')).toBe(false);
  });
});
