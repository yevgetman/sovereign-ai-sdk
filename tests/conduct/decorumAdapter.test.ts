// tests/conduct/decorumAdapter.test.ts — UNIT tests for the decorum adapter
// (src/conduct/decorumAdapter.ts). Where tests/server/gatewayConduct.test.ts
// proves ENFORCEMENT end-to-end through buildRuntime, this file pins the
// adapter's own contract: the capability SHAPE it returns from a real binding,
// the two documented first-release omissions (triage + audit), and its
// fail-closed posture on a bad/absent path.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { createDecorumAdapter } from '../../src/conduct/decorumAdapter.js';

/** The shipped assistant-core deploy binding (resolved through the package). */
const DECORUM_ROOT = dirname(Bun.resolveSync('@yevgetman/decorum/package.json', import.meta.dir));
const ASSISTANT_CORE_BINDING = join(DECORUM_ROOT, 'profiles/deploy/assistant-core.conduct.yaml');

describe('decorum adapter', () => {
  test('a valid binding yields a REAL ConductProvider with the mechanical capabilities', () => {
    const provider = createDecorumAdapter({ configPath: ASSISTANT_CORE_BINDING });
    // The mechanical organs are all present — persona projection, input gate,
    // tool policy, output governor, and the per-turn-instruction gate.
    expect(typeof provider.personaSegments).toBe('function');
    expect(typeof provider.preGate).toBe('function');
    expect(typeof provider.toolPolicy).toBe('function');
    expect(provider.outputGuard).toBeDefined();
    expect(typeof provider.allowPerTurnInstructions).toBe('function');
  });

  test('triage is DROPPED for this release (no host reasoner wired)', () => {
    const provider = createDecorumAdapter({ configPath: ASSISTANT_CORE_BINDING });
    // The adapter wires `reasoner: undefined`, so decorum omits the triage
    // capability entirely — every other floor still enforces without it.
    expect(provider.triage).toBeUndefined();
  });

  test('no emitExternalTrace ⇒ no auditSink (byte-identical to no-audit)', () => {
    const provider = createDecorumAdapter({ configPath: ASSISTANT_CORE_BINDING });
    // Absent the late-bound `emitExternalTrace` inlet, the adapter forwards NO
    // `auditSink` to decorum, so the returned provider carries none — the audit
    // seam is fully inert and the boot path is byte-identical to today.
    expect(provider.auditSink).toBeUndefined();
  });

  test('forwards decorum rich audit as external/source:decorum, drops bare seam events', () => {
    const out: Array<[string, TraceEvent]> = [];
    const provider = createDecorumAdapter({
      configPath: ASSISTANT_CORE_BINDING,
      emitExternalTrace: (sid, ev) => out.push([sid, ev]),
    });
    const sink = provider.auditSink;
    expect(sink).toBeDefined();
    if (sink === undefined) throw new Error('expected an auditSink when emitExternalTrace is set');
    // decorum's own rich event (carries a schemaVersion) → forwarded, wrapped as
    // an external/source:decorum trace event routed by its sessionId:
    sink({
      schemaVersion: 'decorum.audit/1',
      stage: 'output',
      sessionId: 's1',
      surface: 'user',
      verdict: 'block',
      ruleIds: ['r1'],
      configHash: 'h',
      iso: 'now',
      // biome-ignore lint/suspicious/noExplicitAny: hand-built audit event fixture
    } as any);
    // a bare SDK-seam re-exposure (no schemaVersion) → dropped (dedup):
    sink({
      stage: 'persona',
      sessionId: 's1',
      surface: 'user',
      verdict: 'ok',
      iso: 'now',
      // biome-ignore lint/suspicious/noExplicitAny: hand-built audit event fixture
    } as any);
    expect(out).toHaveLength(1);
    const entry = out[0];
    if (entry === undefined) throw new Error('expected a forwarded event');
    const [sid, ev] = entry;
    expect(sid).toBe('s1');
    expect(ev).toMatchObject({ type: 'external', source: 'decorum', iso: 'now' });
    expect((ev as { payload: { ruleIds: string[] } }).payload.ruleIds).toEqual(['r1']);
  });

  test('FAILS CLOSED on a missing/invalid pack path (throws — no silent null provider)', () => {
    const missing = join(tmpdir(), `no-such-binding-${Date.now()}.conduct.yaml`);
    expect(() => createDecorumAdapter({ configPath: missing })).toThrow();
  });

  test('FAILS CLOSED when neither configPath nor packDir is supplied', () => {
    expect(() => createDecorumAdapter()).toThrow(/requires a path/);
    expect(() => createDecorumAdapter({})).toThrow(/requires a path/);
  });
});
