// tests/conduct/decorumAdapter.test.ts — UNIT tests for the decorum adapter
// (src/conduct/decorumAdapter.ts). Where tests/server/gatewayConduct.test.ts
// proves ENFORCEMENT end-to-end through buildRuntime, this file pins the
// adapter's own contract: the capability SHAPE it returns from a real binding,
// the two documented first-release omissions (triage + audit), and its
// fail-closed posture on a bad/absent path.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  test('the audit sink is OMITTED for this release (no sov audit channel wired)', () => {
    const provider = createDecorumAdapter({ configPath: ASSISTANT_CORE_BINDING });
    // No `auditSink` is forwarded to decorum, so the returned provider carries
    // none — the SDK's audit seam is a no-op until the audit seam is wired.
    expect(provider.auditSink).toBeUndefined();
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
