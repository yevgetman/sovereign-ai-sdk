// PostTurnRequest — optional per-turn `instructions` override.
//
// Additive + optional: a turn body MAY carry an ephemeral `instructions` string
// delivered to the model as a per-turn system segment for THIS turn only (never
// persisted in session history). A body WITHOUT `instructions` must be
// byte-identical to today (the field is absent, not `undefined`), so existing
// clients keep the exact same wire shape.

import { describe, expect, test } from 'bun:test';
import type { PostTurnRequest } from '@yevgetman/sov-protocol';

describe('PostTurnRequest — optional per-turn instructions', () => {
  test('a request WITHOUT instructions is byte-identical to today', () => {
    const req: PostTurnRequest = { text: 'hi' };
    // No `instructions` key is emitted — the serialized shape matches the
    // pre-change contract exactly. A doubled/undefined key would break this.
    expect(JSON.stringify(req)).toBe('{"text":"hi"}');
    expect('instructions' in req).toBe(false);
  });

  test('a request MAY carry an optional instructions override', () => {
    const req: PostTurnRequest = { text: 'hi', instructions: 'DO X' };
    expect(req.instructions).toBe('DO X');
    // The pre-existing fields are unaffected by the additive field.
    expect(req.text).toBe('hi');
    expect(JSON.stringify(req)).toBe('{"text":"hi","instructions":"DO X"}');
  });

  test('instructions composes with model and kind (all additive per-turn overrides)', () => {
    const req: PostTurnRequest = {
      text: '/plan',
      kind: 'skill',
      model: 'claude-haiku-4-5',
      instructions: 'DO X',
    };
    expect(req.kind).toBe('skill');
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.instructions).toBe('DO X');
  });
});
