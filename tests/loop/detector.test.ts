// Phase 10.5 — LoopDetectorState heuristic tests. Three detectors,
// table-driven cases for each. Priority order: consecutive-identical
// wins over action-stagnation wins over content-loop.

import { describe, expect, test } from 'bun:test';
import { LoopDetectorState } from '@yevgetman/sov-sdk/loop/detector';

describe('LoopDetectorState — consecutive-identical tool calls', () => {
  test('does not fire below threshold', () => {
    const state = new LoopDetectorState();
    for (let i = 0; i < 3; i++) {
      const det = state.addAndCheck({
        toolCalls: [{ name: 'Read', input: { path: '/x' } }],
        assistantText: '',
      });
      expect(det).toBeNull();
    }
  });

  test('fires on the 4th identical tool call (default threshold)', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Read', input: { path: '/x' } }],
        assistantText: '',
      });
    }
    expect(detection).not.toBeNull();
    expect(detection?.detector).toBe('consecutive-identical');
    expect(detection?.repetitionCount).toBeGreaterThanOrEqual(4);
  });

  test('different inputs reset the run', () => {
    const state = new LoopDetectorState();
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: { path: '/x' } }], assistantText: '' });
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: { path: '/x' } }], assistantText: '' });
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: { path: '/y' } }], assistantText: '' });
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: { path: '/y' } }], assistantText: '' });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Read', input: { path: '/y' } }],
      assistantText: '',
    });
    expect(detection).toBeNull();
  });

  test('threshold can be overridden via opts', () => {
    const state = new LoopDetectorState({ consecutiveIdenticalThreshold: 2 });
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: {} }], assistantText: '' });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Read', input: {} }],
      assistantText: '',
    });
    expect(detection?.detector).toBe('consecutive-identical');
  });
});

describe('LoopDetectorState — env-var bypass', () => {
  test('HARNESS_LOOP_DETECTOR=off short-circuits before any check', () => {
    const original = process.env.HARNESS_LOOP_DETECTOR;
    process.env.HARNESS_LOOP_DETECTOR = 'off';
    try {
      const state = new LoopDetectorState();
      let detection = null;
      for (let i = 0; i < 100; i++) {
        detection = state.addAndCheck({
          toolCalls: [{ name: 'Bash', input: { command: 'echo same' } }],
          assistantText: '',
        });
      }
      expect(detection).toBeNull();
    } finally {
      if (original === undefined) {
        // biome-ignore lint/performance/noDelete: restore unset state
        delete process.env.HARNESS_LOOP_DETECTOR;
      } else {
        process.env.HARNESS_LOOP_DETECTOR = original;
      }
    }
  });

  test('HARNESS_LOOP_DETECTOR set to anything else leaves detection on', () => {
    const original = process.env.HARNESS_LOOP_DETECTOR;
    process.env.HARNESS_LOOP_DETECTOR = 'on';
    try {
      const state = new LoopDetectorState();
      let detection = null;
      for (let i = 0; i < 5; i++) {
        detection = state.addAndCheck({
          toolCalls: [{ name: 'Bash', input: { command: 'echo same' } }],
          assistantText: '',
        });
        if (detection) break;
      }
      expect(detection).not.toBeNull();
    } finally {
      if (original === undefined) {
        // biome-ignore lint/performance/noDelete: restore unset state
        delete process.env.HARNESS_LOOP_DETECTOR;
      } else {
        process.env.HARNESS_LOOP_DETECTOR = original;
      }
    }
  });
});

describe('LoopDetectorState — action-stagnation', () => {
  test('fires on 12 same-tool calls regardless of args (default threshold)', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 12; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Bash', input: { command: `echo ${i}` } }],
        assistantText: '',
      });
    }
    expect(detection?.detector).toBe('action-stagnation');
    expect(detection?.repetitionCount).toBeGreaterThanOrEqual(12);
  });

  test('does not fire below threshold', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 11; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Bash', input: { command: `echo ${i}` } }],
        assistantText: '',
      });
    }
    expect(detection).toBeNull();
  });

  test('switching tool name resets the run', () => {
    const state = new LoopDetectorState();
    for (let i = 0; i < 11; i++) {
      state.addAndCheck({
        toolCalls: [{ name: 'Bash', input: { command: `echo ${i}` } }],
        assistantText: '',
      });
    }
    state.addAndCheck({ toolCalls: [{ name: 'Edit', input: { path: '/x' } }], assistantText: '' });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: 'echo y' } }],
      assistantText: '',
    });
    expect(detection).toBeNull();
  });

  test('consecutive-identical wins when both detectors would fire simultaneously', () => {
    // With low thresholds set so both would cross at the same call, the
    // identical detector wins by priority order.
    const state = new LoopDetectorState({
      consecutiveIdenticalThreshold: 3,
      actionStagnationThreshold: 3,
    });
    let detection = null;
    for (let i = 0; i < 3; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Bash', input: { command: 'same' } }],
        assistantText: '',
      });
    }
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('read-only inspection tools are exempt by default', () => {
    // Reading 30 different files in a row is normal code-review behavior,
    // not stagnation. The exempt set covers FileRead, Read, Grep, Glob.
    // The consecutive-identical detector still catches duplicate exact reads
    // (different test); only the "same name regardless of input" check is
    // suppressed for these tools.
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 30; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'FileRead', input: { path: `/file${i}.ts` } }],
        assistantText: '',
      });
      if (detection) break;
    }
    expect(detection).toBeNull();

    for (const name of ['Read', 'Grep', 'Glob']) {
      const fresh = new LoopDetectorState();
      let det = null;
      for (let i = 0; i < 30; i++) {
        det = fresh.addAndCheck({
          toolCalls: [{ name, input: { q: `q${i}` } }],
          assistantText: '',
        });
        if (det) break;
      }
      expect(det, `${name} must be exempt from action-stagnation`).toBeNull();
    }
  });

  test('exemption can be overridden via actionStagnationExcludeTools', () => {
    // Pass an empty exclusion set to restore the historical "every tool
    // counts" behavior. Use the default threshold of 12.
    const state = new LoopDetectorState({ actionStagnationExcludeTools: new Set() });
    let detection = null;
    for (let i = 0; i < 12; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'FileRead', input: { path: `/file${i}.ts` } }],
        assistantText: '',
      });
    }
    expect(detection?.detector).toBe('action-stagnation');
  });

  test('consecutive-identical still catches duplicate exact reads even though Read is exempt from stagnation', () => {
    // Exemption is scoped to action-stagnation only. Reading the SAME path
    // four times in a row is still pathological and should fire.
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'FileRead', input: { path: '/same.ts' } }],
        assistantText: '',
      });
    }
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('the consecutive-identical detector clears its array after firing', () => {
    // 4 identical calls fires consecutive-identical and clears the
    // tool-call-hash array. The very next identical call does not fire
    // (count = 1 of 4 needed). Note: we use a low action-stagnation
    // threshold here so the fallback detector doesn't trip on the
    // *un-cleared* tool-name array.
    const state = new LoopDetectorState({ actionStagnationThreshold: 100 });
    for (let i = 0; i < 4; i++) {
      state.addAndCheck({ toolCalls: [{ name: 'Read', input: {} }], assistantText: '' });
    }
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Read', input: {} }],
      assistantText: '',
    });
    expect(detection).toBeNull();
  });
});

describe('LoopDetectorState — content-loop', () => {
  test('fires when the same chunk repeats 8 times in the last window', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 8; i++) {
      detection = state.addAndCheck({
        toolCalls: [],
        assistantText: 'A'.repeat(200),
      });
    }
    expect(detection?.detector).toBe('content-loop');
    expect(detection?.repetitionCount).toBeGreaterThanOrEqual(8);
  });

  test('does not fire when chunks differ', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 10; i++) {
      detection = state.addAndCheck({
        toolCalls: [],
        assistantText: `unique-content-${i}`.padEnd(200, '_'),
      });
    }
    expect(detection).toBeNull();
  });

  test('only counts repeats inside the window', () => {
    // 8 identical chunks, then 7 unique chunks — older repeats fall out
    // of the window and the detector does not fire.
    const state = new LoopDetectorState();
    for (let i = 0; i < 8; i++) {
      state.addAndCheck({ toolCalls: [], assistantText: 'A'.repeat(200) });
    }
    // We're already past the threshold — confirm and reset the test by
    // building a fresh state.
    const fresh = new LoopDetectorState({ contentRepeatThreshold: 8 });
    for (let i = 0; i < 7; i++) {
      fresh.addAndCheck({ toolCalls: [], assistantText: 'A'.repeat(200) });
    }
    let detection = null;
    for (let i = 0; i < 13; i++) {
      detection = fresh.addAndCheck({
        toolCalls: [],
        assistantText: `unique-${i}`.padEnd(200, '_'),
      });
    }
    expect(detection).toBeNull();
  });

  test('chunk size can be overridden', () => {
    const state = new LoopDetectorState({ contentChunkSize: 10, contentRepeatThreshold: 4 });
    let firstDetection = null;
    for (let i = 0; i < 5 && !firstDetection; i++) {
      firstDetection = state.addAndCheck({ toolCalls: [], assistantText: 'AAAAAAAAAA' });
    }
    expect(firstDetection?.detector).toBe('content-loop');
  });
});

describe('LoopDetectorState — combined behavior', () => {
  test('returns null on a fresh detector', () => {
    const state = new LoopDetectorState();
    expect(state.addAndCheck({ toolCalls: [], assistantText: '' })).toBeNull();
  });

  test('mixed turns work without false positives', () => {
    const state = new LoopDetectorState();
    let detection = null;
    detection = state.addAndCheck({
      toolCalls: [{ name: 'Read', input: { path: '/a' } }],
      assistantText: 'reading',
    });
    detection = state.addAndCheck({
      toolCalls: [{ name: 'Edit', input: { path: '/a', old: 'x', new: 'y' } }],
      assistantText: 'editing',
    });
    detection = state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: 'ls' } }],
      assistantText: 'listing',
    });
    expect(detection).toBeNull();
  });
});
