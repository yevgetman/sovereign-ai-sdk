// tests/core/conductPort.test.ts — port-type contract + audit wrapper.
//
// The ConductProvider port is ALL-OPTIONAL (spec §10 item 9 resolution: one
// interface, optional capability slices): an empty object is a valid provider
// and must behave as the null provider at every seam. wrapConductAuditSink
// mirrors makeTraceRecorder (query.ts): absent sink → no-op; a throwing sink
// is swallowed (a misbehaving audit sink must never break a turn).

import { describe, expect, test } from 'bun:test';
import {
  type ConductAuditEvent,
  type ConductContext,
  type ConductProvider,
  DEFAULT_CONDUCT_REFUSAL,
  wrapConductAuditSink,
} from '@yevgetman/sov-sdk/core/conductPort';

describe('conductPort', () => {
  test('an empty object is a valid ConductProvider (all capabilities optional)', () => {
    const provider: ConductProvider = {};
    expect(provider.personaSegments).toBeUndefined();
    expect(provider.preGate).toBeUndefined();
    expect(provider.triage).toBeUndefined();
    expect(provider.toolPolicy).toBeUndefined();
    expect(provider.outputGuard).toBeUndefined();
    expect(provider.allowPerTurnInstructions).toBeUndefined();
    expect(provider.auditSink).toBeUndefined();
  });

  test('wrapConductAuditSink: absent sink is a no-op function', () => {
    const emit = wrapConductAuditSink(undefined);
    expect(() =>
      emit({
        stage: 'pregate',
        sessionId: 's1',
        surface: 'user',
        verdict: 'allow',
        iso: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  test('wrapConductAuditSink: a throwing sink is swallowed, events still delivered before the throw', () => {
    const seen: ConductAuditEvent[] = [];
    const emit = wrapConductAuditSink((event) => {
      seen.push(event);
      throw new Error('sink exploded');
    });
    const ctx: ConductContext = {
      sessionId: 's1',
      surface: 'user',
      model: 'm',
      providerName: 'p',
    };
    expect(() =>
      emit({
        stage: 'output',
        sessionId: ctx.sessionId,
        surface: ctx.surface,
        verdict: 'pass',
        latencyMs: 3,
        iso: new Date().toISOString(),
      }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stage).toBe('output');
  });

  test('DEFAULT_CONDUCT_REFUSAL is a non-empty string', () => {
    expect(DEFAULT_CONDUCT_REFUSAL.length).toBeGreaterThan(0);
  });
});
