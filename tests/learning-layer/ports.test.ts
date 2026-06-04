// tests/learning-layer/ports.test.ts
import { describe, expect, test } from 'bun:test';
import type {
  CapturedSession,
  LearningHostDeps,
  PersistPort,
  ReasonPort,
  RecallResult,
} from '../../src/learning-layer/ports.js';

describe('ports contract', () => {
  test('a minimal host-deps object type-checks', () => {
    const persist: PersistPort = {
      read: async () => null,
      write: async () => {},
      list: async () => [],
      remove: async () => {},
    };
    const reason: ReasonPort = { complete: async () => 'ok' };
    const deps: LearningHostDeps = { persist, reason };
    expect(typeof deps.persist.read).toBe('function');
  });

  test('RecallResult/CapturedSession are well-formed', () => {
    const r: RecallResult = { injectionText: '', lessons: [] };
    const s: CapturedSession = {
      sessionId: 's',
      projectId: 'p',
      turns: [],
      terminalReason: 'completed',
    };
    expect(r.lessons).toEqual([]);
    expect(s.turns).toEqual([]);
  });
});
