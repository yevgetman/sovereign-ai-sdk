// buildLoopOptions — the settings → LoopOptions normalizer (T4).
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.4, §3.6.
//
// The Zod `loop` block infers every field as `T | undefined`, which under
// `exactOptionalPropertyTypes: true` is NOT assignable to `LoopOptions`
// (where an absent key and a `undefined`-valued key are different types).
// The normalizer is the repo's standard bridge for that (same shape as
// `buildMicrocompactConfig`), with one deliberate difference: it does NOT
// merge defaults. Absent ⇒ absent, so an unconfigured deployment hands the
// detector exactly what it handed it before this block existed.

import { describe, expect, test } from 'bun:test';
import { buildLoopOptions } from '@yevgetman/sov-sdk/loop/options';

describe('buildLoopOptions', () => {
  test('returns undefined for undefined input', () => {
    expect(buildLoopOptions(undefined)).toBeUndefined();
  });

  test('returns undefined for null input', () => {
    expect(buildLoopOptions(null)).toBeUndefined();
  });

  test('returns undefined for an empty block', () => {
    expect(buildLoopOptions({})).toBeUndefined();
  });

  test('returns undefined when every key is explicitly undefined', () => {
    expect(
      buildLoopOptions({
        mode: undefined,
        consecutiveIdenticalThreshold: undefined,
        noProgressWindow: undefined,
        contentChunkSize: undefined,
        contentRepeatThreshold: undefined,
        contentWindowMultiplier: undefined,
        sideEffectTools: undefined,
        maxStrikes: undefined,
      }),
    ).toBeUndefined();
  });

  test('drops undefined keys and keeps the defined ones', () => {
    const out = buildLoopOptions({ mode: undefined, noProgressWindow: 3 });
    expect(out).toEqual({ noProgressWindow: 3 });
    // The key must be ABSENT, not present-and-undefined — that is the whole
    // point of the normalizer under exactOptionalPropertyTypes.
    expect(out !== undefined && 'mode' in out).toBe(false);
  });

  test('does NOT merge defaults — an absent key stays absent', () => {
    const out = buildLoopOptions({ mode: 'off' });
    expect(out).toEqual({ mode: 'off' });
    expect(Object.keys(out ?? {})).toEqual(['mode']);
  });

  test('a full block round-trips verbatim', () => {
    const full = {
      mode: 'warn' as const,
      consecutiveIdenticalThreshold: 5,
      noProgressWindow: 12,
      contentChunkSize: 300,
      contentRepeatThreshold: 9,
      contentWindowMultiplier: 2,
      sideEffectTools: ['Bash', 'memory_propose'],
      maxStrikes: 3,
    };
    expect(buildLoopOptions(full)).toEqual(full);
  });

  test('sideEffectTools is copied, not aliased', () => {
    const sideEffectTools = ['Bash'];
    const out = buildLoopOptions({ sideEffectTools });
    expect(out?.sideEffectTools).toEqual(['Bash']);
    expect(out?.sideEffectTools).not.toBe(sideEffectTools);
  });

  test('does not mutate its input', () => {
    const raw = { mode: 'enforce' as const, sideEffectTools: ['Bash'] };
    const snapshot = JSON.stringify(raw);
    buildLoopOptions(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
