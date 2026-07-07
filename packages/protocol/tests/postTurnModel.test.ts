// PostTurnRequest — optional per-turn `model` override.
//
// Additive + optional: a turn body MAY carry a `model` to run THIS turn on a
// different model without a new gateway process. A body WITHOUT `model` must be
// byte-identical to today (the field is absent, not `undefined`), so existing
// clients keep the exact same wire shape.

import { describe, expect, test } from 'bun:test';
import type { PostTurnRequest } from '@yevgetman/sov-protocol';

describe('PostTurnRequest — optional per-turn model', () => {
  test('a request WITHOUT model is byte-identical to today', () => {
    const req: PostTurnRequest = { text: 'hi' };
    // No `model` key is emitted — the serialized shape matches the pre-change
    // contract exactly. A doubled/undefined `model` key would break this.
    expect(JSON.stringify(req)).toBe('{"text":"hi"}');
    expect('model' in req).toBe(false);
  });

  test('a request MAY carry an optional model override', () => {
    const req: PostTurnRequest = { text: 'hi', model: 'claude-sonnet-4-6' };
    expect(req.model).toBe('claude-sonnet-4-6');
    // The pre-existing fields are unaffected by the additive field.
    expect(req.text).toBe('hi');
    expect(JSON.stringify(req)).toBe('{"text":"hi","model":"claude-sonnet-4-6"}');
  });

  test('model composes with kind (skill turns can also override the model)', () => {
    const req: PostTurnRequest = { text: '/plan', kind: 'skill', model: 'claude-haiku-4-5' };
    expect(req.kind).toBe('skill');
    expect(req.model).toBe('claude-haiku-4-5');
  });
});
