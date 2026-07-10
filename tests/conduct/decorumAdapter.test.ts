import { describe, expect, test } from 'bun:test';
import { createDecorumAdapter } from '../../src/conduct/decorumAdapter.js';

describe('decorum adapter skeleton', () => {
  test('returns a valid, INERT ConductProvider (no capabilities yet)', () => {
    const provider = createDecorumAdapter();
    expect(provider.personaSegments).toBeUndefined();
    expect(provider.preGate).toBeUndefined();
    expect(provider.triage).toBeUndefined();
    expect(provider.toolPolicy).toBeUndefined();
    expect(provider.outputGuard).toBeUndefined();
    expect(provider.allowPerTurnInstructions).toBeUndefined();
    expect(provider.auditSink).toBeUndefined();
  });
});
