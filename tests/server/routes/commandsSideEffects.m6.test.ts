// 2026-06-14 config live-apply (M6) — T5 wire-seams 2+3.
//
// The commands route enumerates every CommandSideEffects field EXPLICITLY in
// its two private seams — hasSideEffects (does the bag carry anything?) and
// pickSideEffects (copy only the set fields onto the wire). Per the project's
// 5-wire-seam rule a NEW side-effect field is set-but-silently-dropped unless
// both of these enumerate it. T1 added the M6 fields to CommandSideEffectsSchema
// (schema = seam 4); this suite proves they survive seams 2+3.
//
// The route exposes hasSideEffects + pickSideEffects as named exports so the
// round-trip can be asserted WITHOUT coupling to the collector
// (commandContext.ts, seam 1) or the Go decoder (seam 5) landing order. A full
// HTTP round-trip via app.request() drives the SAME pickSideEffects on the wire
// (covered by commands.test.ts for the pre-existing fields), so this unit-level
// proof of the new fields is the faithful, isolation-safe mirror.

import { describe, expect, test } from 'bun:test';
import { hasSideEffects, pickSideEffects } from '../../../src/server/routes/commands.js';

describe('commands route side-effect seams — M6 chrome reflections (T5)', () => {
  test('hasSideEffects detects permissionModeChanged', () => {
    expect(hasSideEffects({ permissionModeChanged: 'bypass' })).toBe(true);
  });

  test('hasSideEffects detects toolOutputChanged', () => {
    expect(hasSideEffects({ toolOutputChanged: { mode: 'detailed', inlineLines: 10 } })).toBe(true);
  });

  test('hasSideEffects detects footerChanged', () => {
    expect(hasSideEffects({ footerChanged: true })).toBe(true);
  });

  test('hasSideEffects detects contextMeterChanged', () => {
    expect(
      hasSideEffects({ contextMeterChanged: { warnAtPercent: 70, dangerAtPercent: 90 } }),
    ).toBe(true);
  });

  test('hasSideEffects detects diffRenderChanged', () => {
    expect(hasSideEffects({ diffRenderChanged: false })).toBe(true);
  });

  test('hasSideEffects stays false for an empty bag (regression guard)', () => {
    expect(hasSideEffects({})).toBe(false);
  });

  test('pickSideEffects relays permissionModeChanged onto the wire', () => {
    const out = pickSideEffects({ permissionModeChanged: 'bypass' });
    expect(out.permissionModeChanged).toBe('bypass');
  });

  test('pickSideEffects relays toolOutputChanged onto the wire (object survives)', () => {
    const toolOutputChanged = { mode: 'detailed', inlineLines: 12 };
    const out = pickSideEffects({ toolOutputChanged });
    expect(out.toolOutputChanged).toEqual(toolOutputChanged);
  });

  test('pickSideEffects relays footerChanged onto the wire', () => {
    const out = pickSideEffects({ footerChanged: true });
    expect(out.footerChanged).toBe(true);
  });

  test('pickSideEffects relays contextMeterChanged onto the wire (object survives)', () => {
    const contextMeterChanged = { warnAtPercent: 65, dangerAtPercent: 88 };
    const out = pickSideEffects({ contextMeterChanged });
    expect(out.contextMeterChanged).toEqual(contextMeterChanged);
  });

  test('pickSideEffects relays diffRenderChanged onto the wire (false survives, not dropped)', () => {
    // false is a meaningful value here — guard against an `if (s.x)` truthiness
    // bug. The seam uses `!== undefined`, so an explicit `false` must pass.
    const out = pickSideEffects({ diffRenderChanged: false });
    expect(out.diffRenderChanged).toBe(false);
  });

  test('pickSideEffects relays all five M6 fields together', () => {
    const bag = {
      permissionModeChanged: 'default',
      toolOutputChanged: { mode: 'compact' },
      footerChanged: false,
      contextMeterChanged: { warnAtPercent: 70 },
      diffRenderChanged: true,
    };
    const out = pickSideEffects(bag);
    expect(out).toEqual(bag);
  });

  test('pickSideEffects drops unset M6 fields (no undefined keys leak onto wire)', () => {
    // Mixing a pre-existing field with one M6 field: only the two set keys
    // appear; the other four M6 keys must NOT be present (not even as
    // explicit `undefined`).
    const out = pickSideEffects({ modelChanged: 'claude-sonnet-4-6', footerChanged: true });
    expect(out).toEqual({ modelChanged: 'claude-sonnet-4-6', footerChanged: true });
    expect(Object.keys(out).sort()).toEqual(['footerChanged', 'modelChanged']);
    expect('permissionModeChanged' in out).toBe(false);
    expect('toolOutputChanged' in out).toBe(false);
    expect('contextMeterChanged' in out).toBe(false);
    expect('diffRenderChanged' in out).toBe(false);
  });
});
