import { describe, expect, test } from 'bun:test';
import { insertPersonaSegments } from '@yevgetman/sov-sdk/core/conductSegments';
import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';

const seg = (text: string, cacheable: boolean): SystemSegment => ({ text, cacheable });

describe('insertPersonaSegments', () => {
  test('inserts after the last cacheable segment, before the dynamic tail', () => {
    const base = [
      seg('base', true),
      seg('bundle', true),
      seg('sysctx', false),
      seg('userctx', false),
    ];
    const persona = [seg('persona-identity', true), seg('persona-voice', true)];
    const out = insertPersonaSegments(base, persona);
    expect(out.map((s) => s.text)).toEqual([
      'base',
      'bundle',
      'persona-identity',
      'persona-voice',
      'sysctx',
      'userctx',
    ]);
  });

  test('prepends when no base segment is cacheable (identity-first)', () => {
    const base = [seg('dynamic-only', false)];
    const persona = [seg('persona', true)];
    expect(insertPersonaSegments(base, persona).map((s) => s.text)).toEqual([
      'persona',
      'dynamic-only',
    ]);
  });

  test('empty persona returns the SAME array reference (no-op fast path)', () => {
    const base = [seg('a', true)];
    expect(insertPersonaSegments(base, [])).toBe(base);
  });

  test('never mutates the inputs', () => {
    const base = [seg('a', true), seg('b', false)];
    const persona = [seg('p', true)];
    const baseCopy = structuredClone(base);
    const personaCopy = structuredClone(persona);
    insertPersonaSegments(base, persona);
    expect(base).toEqual(baseCopy);
    expect(persona).toEqual(personaCopy);
  });
});
