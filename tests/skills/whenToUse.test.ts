// Phase 9.6 — whenToUse rigor heuristic. Validates the predicate-vs-description
// distinction the loader uses to warn skill authors at load time, plus the
// semicolon-splitter used by SkillsListTool to surface multi-trigger arrays.

import { describe, expect, test } from 'bun:test';
import { splitWhenToUseTriggers, validateWhenToUse } from '../../src/skills/whenToUse.js';

describe('validateWhenToUse', () => {
  test('accepts a clean predicate trigger', () => {
    expect(validateWhenToUse('User asks to simplify code')).toEqual({ ok: true });
    expect(validateWhenToUse('User mentions a commit, branch, or remote')).toEqual({ ok: true });
    expect(validateWhenToUse('Agent attempts to deploy to production')).toEqual({ ok: true });
  });

  test('flags low-rigor preambles', () => {
    const res = validateWhenToUse('Use this skill when working with git');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('preamble');
  });

  test('flags description-style strings without trigger verbs', () => {
    const res = validateWhenToUse('General-purpose code review and refactoring guidance');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('trigger verb');
  });

  test('flags empty whenToUse', () => {
    const res = validateWhenToUse('');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('empty');
  });

  test('flags very short whenToUse', () => {
    const res = validateWhenToUse('git');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('too short');
  });

  test('accepts multi-trigger semicolon-separated predicates', () => {
    expect(validateWhenToUse('User asks to deploy; user mentions production rollout')).toEqual({
      ok: true,
    });
  });

  test('treats "Activate this skill when…" as a low-rigor preamble', () => {
    const res = validateWhenToUse('Activate this skill when the user requests a review');
    expect(res.ok).toBe(false);
  });
});

describe('splitWhenToUseTriggers', () => {
  test('returns one element for a single trigger', () => {
    expect(splitWhenToUseTriggers('User asks to simplify code')).toEqual([
      'User asks to simplify code',
    ]);
  });

  test('splits on semicolons and trims whitespace', () => {
    expect(
      splitWhenToUseTriggers('User asks to deploy; user mentions production; Bash(kubectl *)'),
    ).toEqual(['User asks to deploy', 'user mentions production', 'Bash(kubectl *)']);
  });

  test('drops empty fragments from trailing or doubled semicolons', () => {
    expect(splitWhenToUseTriggers('A; ; B; ')).toEqual(['A', 'B']);
  });

  test('returns an empty array for an empty value', () => {
    expect(splitWhenToUseTriggers('')).toEqual([]);
  });
});
