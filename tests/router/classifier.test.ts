// Phase 10.6 — classifier rule tests. Pure function; covers user
// overrides, frontier triggers, escalation-mode resolution, and the
// default-local path.

import { describe, expect, test } from 'bun:test';
import { classify } from '../../src/router/classifier.js';
import type { RouterConfig } from '../../src/router/types.js';

const baseConfig: RouterConfig = {
  localProvider: 'ollama',
  frontierProvider: 'anthropic',
};

describe('classify — user overrides', () => {
  test("'frontier' override always wins, even with no triggers", () => {
    const decision = classify(baseConfig, { prompt: 'x', userOverride: 'frontier' });
    expect(decision.lane).toBe('frontier');
    expect(decision.classifierLane).toBe('frontier');
    expect(decision.reason).toContain('user override');
  });

  test("'local' override always wins, even when triggers would fire", () => {
    const decision = classify(baseConfig, {
      prompt: 'x',
      userOverride: 'local',
      recentToolErrors: 99,
    });
    expect(decision.lane).toBe('local');
    expect(decision.classifierLane).toBe('local');
  });
});

describe('classify — frontier triggers', () => {
  test('tool-error threshold (3) trips local-with-escalation', () => {
    const decision = classify(baseConfig, { prompt: 'x', recentToolErrors: 3 });
    expect(decision.classifierLane).toBe('local-with-escalation');
  });

  test('below the tool-error threshold stays local', () => {
    const decision = classify(baseConfig, { prompt: 'x', recentToolErrors: 2 });
    expect(decision.classifierLane).toBe('local');
    expect(decision.lane).toBe('local');
  });

  test('schema-failure threshold (2) trips local-with-escalation', () => {
    const decision = classify(baseConfig, { prompt: 'x', recentSchemaFailures: 2 });
    expect(decision.classifierLane).toBe('local-with-escalation');
  });

  test('context overflow (byteCount > 4 * localContextLength) is a HARD frontier trigger', () => {
    // Local is structurally unable to fit the prompt — escalate directly to
    // frontier, not local-with-escalation (which would defer to escalationMode).
    const decision = classify(baseConfig, {
      prompt: 'x',
      contextByteCount: 4001,
      localContextLength: 1000,
    });
    expect(decision.classifierLane).toBe('frontier');
    expect(decision.lane).toBe('frontier');
    expect(decision.reason).toContain('context overflow');
  });

  test('context overflow escalates even when escalationMode is never', () => {
    // The hard trigger must override escalation mode — local cannot continue.
    const decision = classify(
      { ...baseConfig, escalationMode: 'never' },
      { prompt: 'x', contextByteCount: 4001, localContextLength: 1000 },
    );
    expect(decision.lane).toBe('frontier');
  });

  test('within local context capacity stays local', () => {
    const decision = classify(baseConfig, {
      prompt: 'x',
      contextByteCount: 3999,
      localContextLength: 1000,
    });
    expect(decision.classifierLane).toBe('local');
  });
});

describe('classify — escalation modes', () => {
  test("'auto' escalates a local-with-escalation classification to frontier", () => {
    const decision = classify(
      { ...baseConfig, escalationMode: 'auto' },
      { prompt: 'x', recentToolErrors: 5 },
    );
    expect(decision.classifierLane).toBe('local-with-escalation');
    expect(decision.lane).toBe('frontier');
    expect(decision.reason).toContain('escalate');
  });

  test("'never' stays on the default lane (local)", () => {
    const decision = classify(
      { ...baseConfig, escalationMode: 'never' },
      { prompt: 'x', recentToolErrors: 5 },
    );
    expect(decision.lane).toBe('local');
  });

  test("'ask' stays local for now (interactive prompting deferred)", () => {
    const decision = classify(
      { ...baseConfig, escalationMode: 'ask' },
      { prompt: 'x', recentToolErrors: 5 },
    );
    expect(decision.lane).toBe('local');
  });

  test('defaultLane override applies when escalation does not promote', () => {
    const decision = classify(
      { ...baseConfig, escalationMode: 'ask', defaultLane: 'frontier' },
      { prompt: 'x', recentToolErrors: 5 },
    );
    expect(decision.lane).toBe('frontier');
  });
});

describe('classify — default path', () => {
  test('returns local when nothing fires', () => {
    const decision = classify(baseConfig, { prompt: 'just a question' });
    expect(decision.lane).toBe('local');
    expect(decision.classifierLane).toBe('local');
    expect(decision.reason).toBe('default lane: local');
  });
});
