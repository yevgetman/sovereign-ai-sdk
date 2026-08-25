// Progress-aware loop guard — LoopDetectorState unit tests.
// Spec: specs/2026-08-25-progress-aware-loop-guard-design.md §3.1–§3.5, §4 "Unit".
//
// Three detectors, priority order: consecutive-identical > no-progress >
// content-loop. `action-stagnation` (same tool NAME N times in a row) is gone —
// it measured turn length, not stuckness, and killed legitimate single-tool
// workloads (§3.5).
//
// Ordering note used throughout: detection is pre-dispatch (`addAndCheck`) and
// the productivity ledger is fed post-dispatch (`observeResults`), so a
// no-progress verdict surfaces on the pre-dispatch check that FOLLOWS the Kth
// unproductive result — one turn late, by design (§3.3).

import { describe, expect, test } from 'bun:test';
import { type LoopDetection, LoopDetectorState } from '@yevgetman/sov-sdk/loop/detector';

/** One full tool round-trip: pre-dispatch check, dispatch, post-dispatch observe. */
function drive(
  state: LoopDetectorState,
  call: { name: string; input: unknown; text: string; isError?: boolean },
): LoopDetection | null {
  const detection = state.addAndCheck({
    toolCalls: [{ name: call.name, input: call.input }],
    assistantText: '',
  });
  state.observeResults([
    {
      name: call.name,
      input: call.input,
      text: call.text,
      isError: call.isError ?? false,
    },
  ]);
  return detection;
}

/** The next pre-dispatch check with nothing new to ingest — where a
 *  no-progress verdict built from the previous turn's results surfaces. */
function nextCheck(state: LoopDetectorState): LoopDetection | null {
  return state.addAndCheck({ toolCalls: [], assistantText: '' });
}

/** Drives `count` calls whose results were all seen before, with varied inputs
 *  so consecutive-identical never fires. Returns the detection from the check
 *  that follows. */
function driveUnproductiveRun(state: LoopDetectorState, count: number, tag: string): void {
  for (let i = 0; i < count; i++) {
    expect(
      drive(state, { name: 'Bash', input: { command: `${tag} ${i}` }, text: `payload ${i}` }),
    ).toBeNull();
  }
}

/** Seeds the session result set so later identical results count as "seen". */
function primeResults(state: LoopDetectorState, count: number): void {
  for (let i = 0; i < count; i++) {
    expect(
      drive(state, { name: 'Bash', input: { command: `first read ${i}` }, text: `payload ${i}` }),
    ).toBeNull();
  }
}

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

  test('the reason names the tool and the repeated input', () => {
    const state = new LoopDetectorState();
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Bash', input: { command: 'resume edit skills/1-x' } }],
        assistantText: '',
      });
    }
    expect(detection?.reason).toContain('Bash');
    expect(detection?.reason).toContain('resume edit skills/1-x');
    expect(detection?.reason.length).toBeGreaterThan(0);
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

  test('clears its history after firing so a fresh run is required', () => {
    const state = new LoopDetectorState();
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

describe('LoopDetectorState — input canonicalisation', () => {
  test('whitespace-only differences hash equal', () => {
    const state = new LoopDetectorState({ consecutiveIdenticalThreshold: 2 });
    state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: 'resume show work/x' } }],
      assistantText: '',
    });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: '  resume   show\n\twork/x ' } }],
      assistantText: '',
    });
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('digit differences do NOT hash equal (skills/1-… ≠ skills/2-…)', () => {
    const state = new LoopDetectorState({ consecutiveIdenticalThreshold: 2 });
    state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: 'resume show skills/1-python' } }],
      assistantText: '',
    });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Bash', input: { command: 'resume show skills/2-python' } }],
      assistantText: '',
    });
    expect(detection).toBeNull();
  });

  test('object key order does not change the hash', () => {
    const state = new LoopDetectorState({ consecutiveIdenticalThreshold: 2 });
    state.addAndCheck({
      toolCalls: [{ name: 'Edit', input: { path: '/a', text: 'x', mode: 'w' } }],
      assistantText: '',
    });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Edit', input: { mode: 'w', text: 'x', path: '/a' } }],
      assistantText: '',
    });
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('the same input under a different tool name does not hash equal', () => {
    const state = new LoopDetectorState({ consecutiveIdenticalThreshold: 2 });
    state.addAndCheck({ toolCalls: [{ name: 'Read', input: { path: '/a' } }], assistantText: '' });
    const detection = state.addAndCheck({
      toolCalls: [{ name: 'Grep', input: { path: '/a' } }],
      assistantText: '',
    });
    expect(detection).toBeNull();
  });
});

describe('LoopDetectorState — no-progress', () => {
  test('30 distinct calls with distinct results on one tool never fire', () => {
    // The regression this whole design exists for: the killed tailor run made
    // 24 distinct `resume show …` calls with 24 distinct results (spec §1).
    const state = new LoopDetectorState();
    for (let i = 0; i < 30; i++) {
      const detection = drive(state, {
        name: 'Bash',
        input: { command: `resume show skills/${i}-entry` },
        text: `section ${i} contents`,
      });
      expect(detection).toBeNull();
    }
    expect(nextCheck(state)).toBeNull();
  });

  test('fires when the last 8 observed calls were all unproductive', () => {
    const state = new LoopDetectorState();
    primeResults(state, 8);
    driveUnproductiveRun(state, 8, 're-read');

    const detection = nextCheck(state);
    expect(detection?.detector).toBe('no-progress');
    expect(detection?.repetitionCount).toBe(8);
    expect(detection?.window).toEqual({ size: 8, unproductive: 8 });
    expect(detection?.hash.length).toBe(64);
  });

  test('does not fire at 7 unproductive calls', () => {
    const state = new LoopDetectorState();
    primeResults(state, 8);
    driveUnproductiveRun(state, 7, 're-read');
    expect(nextCheck(state)).toBeNull();
  });

  test('the window is configurable', () => {
    const state = new LoopDetectorState({ noProgressWindow: 3 });
    primeResults(state, 3);
    driveUnproductiveRun(state, 3, 're-read');
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });

  test('one productive call inside the window prevents a fire', () => {
    const state = new LoopDetectorState();
    primeResults(state, 8);
    driveUnproductiveRun(state, 4, 're-read');
    expect(
      drive(state, { name: 'Bash', input: { command: 'resume show new' }, text: 'brand new' }),
    ).toBeNull();
    driveUnproductiveRun(state, 3, 'second re-read');
    expect(nextCheck(state)).toBeNull();
  });

  test('varied inputs returning the identical error fire no-progress', () => {
    const state = new LoopDetectorState();
    const errorText = 'ValidationError: expected array, received string';
    // The FIRST failure is new information, so it counts as productive; the
    // repeats of that same error are what the guard is looking for.
    expect(
      drive(state, {
        name: 'Bash',
        input: { command: 'resume edit skills/0-x --field level' },
        text: errorText,
        isError: true,
      }),
    ).toBeNull();
    for (let i = 1; i <= 8; i++) {
      expect(
        drive(state, {
          name: 'Bash',
          input: { command: `resume edit skills/${i}-x --field level --retry ${i}` },
          text: errorText,
          isError: true,
        }),
      ).toBeNull();
    }

    const detection = nextCheck(state);
    expect(detection?.detector).toBe('no-progress');
    expect(detection?.window).toEqual({ size: 8, unproductive: 8 });
    expect(detection?.reason).toContain('Bash');
    expect(detection?.reason).toContain('same error');
    expect(detection?.reason).toContain('expected array, received string');
  });

  test('identical inputs fire consecutive-identical first (priority)', () => {
    const state = new LoopDetectorState();
    const errorText = 'ValidationError: expected array, received string';
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = drive(state, {
        name: 'Bash',
        input: { command: 'resume edit skills/1-x --field level' },
        text: errorText,
        isError: true,
      });
    }
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('consecutive-identical wins when both detectors arm on the same check', () => {
    // One productive call, then 5 varied unproductive ones, then 4 identical
    // unproductive ones: on the 4th identical call the last 8 observed results
    // are all unproductive AND the last 4 inputs are identical.
    const state = new LoopDetectorState();
    expect(drive(state, { name: 'Bash', input: { command: 'prime' }, text: 'R' })).toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(
        drive(state, { name: 'Bash', input: { command: `varied ${i}` }, text: 'R' }),
      ).toBeNull();
    }
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = drive(state, { name: 'Bash', input: { command: 'stuck' }, text: 'R' });
    }
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('the reason names the tool and the repeated input with counts', () => {
    const state = new LoopDetectorState();
    primeResults(state, 8);
    driveUnproductiveRun(state, 8, 're-read');
    const detection = nextCheck(state);
    expect(detection?.reason).toContain('Bash');
    expect(detection?.reason).toContain('result already seen');
    expect(detection?.reason).toContain('8 tool calls');
  });

  test('the ledger resets after a strike — a fresh window is required', () => {
    const state = new LoopDetectorState();
    primeResults(state, 8);
    driveUnproductiveRun(state, 8, 're-read');
    expect(nextCheck(state)?.detector).toBe('no-progress');

    driveUnproductiveRun(state, 7, 'third read');
    expect(nextCheck(state)).toBeNull();

    expect(
      drive(state, { name: 'Bash', input: { command: 'third read 7' }, text: 'payload 7' }),
    ).toBeNull();
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });

  test('the seen-results set survives a strike (only the recent run is cleared)', () => {
    const state = new LoopDetectorState({ noProgressWindow: 2 });
    primeResults(state, 2);
    driveUnproductiveRun(state, 2, 're-read');
    expect(nextCheck(state)?.detector).toBe('no-progress');
    // `payload 0` was seen long before the strike; it is still unproductive.
    driveUnproductiveRun(state, 2, 'after strike');
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });

  test('multiple results observed from one turn all land in the ledger', () => {
    const state = new LoopDetectorState({ noProgressWindow: 4 });
    state.addAndCheck({ toolCalls: [], assistantText: '' });
    state.observeResults([
      { name: 'Bash', input: { command: 'a' }, text: 'same', isError: false },
      { name: 'Bash', input: { command: 'b' }, text: 'same', isError: false },
      { name: 'Bash', input: { command: 'c' }, text: 'same', isError: false },
      { name: 'Bash', input: { command: 'd' }, text: 'same', isError: false },
      { name: 'Bash', input: { command: 'e' }, text: 'same', isError: false },
    ]);
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });
});

describe('LoopDetectorState — side-effect tools', () => {
  test('a successful side-effect tool is productive even with an already-seen result', () => {
    for (const name of ['FileEdit', 'FileWrite', 'memory', 'memory_propose']) {
      const state = new LoopDetectorState();
      for (let i = 0; i < 12; i++) {
        expect(
          drive(state, { name, input: { path: `/file-${i}` }, text: 'ok' }),
          `${name} must count as progress when it succeeds`,
        ).toBeNull();
      }
      expect(nextCheck(state), `${name} must count as progress when it succeeds`).toBeNull();
    }
  });

  test('a side-effect tool that errors is NOT productive', () => {
    const state = new LoopDetectorState();
    const errorText = 'EACCES: permission denied';
    expect(
      drive(state, { name: 'FileWrite', input: { path: '/f0' }, text: errorText, isError: true }),
    ).toBeNull();
    for (let i = 1; i <= 8; i++) {
      expect(
        drive(state, {
          name: 'FileWrite',
          input: { path: `/f${i}` },
          text: errorText,
          isError: true,
        }),
      ).toBeNull();
    }
    const detection = nextCheck(state);
    expect(detection?.detector).toBe('no-progress');
    expect(detection?.reason).toContain('FileWrite');
  });

  test('host-supplied sideEffectTools are additive to the built-in set', () => {
    const state = new LoopDetectorState({ sideEffectTools: ['Deploy'] });
    for (let i = 0; i < 12; i++) {
      expect(drive(state, { name: 'Deploy', input: { target: `t${i}` }, text: 'ok' })).toBeNull();
    }
    expect(nextCheck(state)).toBeNull();

    // …and the built-ins still apply alongside it.
    const builtin = new LoopDetectorState({ sideEffectTools: ['Deploy'] });
    for (let i = 0; i < 12; i++) {
      expect(
        drive(builtin, { name: 'FileEdit', input: { path: `/p${i}` }, text: 'ok' }),
      ).toBeNull();
    }
    expect(nextCheck(builtin)).toBeNull();
  });

  test('a non-side-effect tool with an already-seen result is unproductive', () => {
    const state = new LoopDetectorState();
    for (let i = 0; i < 9; i++) {
      expect(drive(state, { name: 'Bash', input: { command: `ls ${i}` }, text: 'ok' })).toBeNull();
    }
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });
});

describe('LoopDetectorState — result hashing', () => {
  test('results are compared on the first 64 KiB only (truncation is stable)', () => {
    const base = 'x'.repeat(65_536);
    const state = new LoopDetectorState();
    expect(
      drive(state, { name: 'Bash', input: { command: 'cat big 0' }, text: `${base}A` }),
    ).toBeNull();
    for (let i = 1; i <= 8; i++) {
      expect(
        drive(state, { name: 'Bash', input: { command: `cat big ${i}` }, text: `${base}B` }),
      ).toBeNull();
    }
    expect(nextCheck(state)?.detector).toBe('no-progress');
  });

  test('a difference inside the first 64 KiB still counts as a new result', () => {
    const state = new LoopDetectorState();
    for (let i = 0; i < 9; i++) {
      expect(
        drive(state, {
          name: 'Bash',
          input: { command: `cat big ${i}` },
          text: `${i}${'x'.repeat(65_600)}`,
        }),
      ).toBeNull();
    }
    expect(nextCheck(state)).toBeNull();
  });

  test('the same text as ok and as error are different results', () => {
    const state = new LoopDetectorState({ noProgressWindow: 2 });
    expect(drive(state, { name: 'Bash', input: { command: 'a' }, text: 'same text' })).toBeNull();
    expect(
      drive(state, { name: 'Bash', input: { command: 'b' }, text: 'same text', isError: true }),
    ).toBeNull();
    expect(nextCheck(state)).toBeNull();
  });
});

describe('LoopDetectorState — modes and kill switch', () => {
  test('exposes mode and maxStrikes with their defaults', () => {
    const state = new LoopDetectorState();
    expect(state.mode).toBe('enforce');
    expect(state.maxStrikes).toBe(2);
  });

  test('mode and maxStrikes are configurable', () => {
    const state = new LoopDetectorState({ mode: 'warn', maxStrikes: 3 });
    expect(state.mode).toBe('warn');
    expect(state.maxStrikes).toBe(3);
  });

  test('mode: off never fires and observeResults is a no-op', () => {
    const state = new LoopDetectorState({ mode: 'off' });
    for (let i = 0; i < 30; i++) {
      expect(drive(state, { name: 'Bash', input: { command: 'same' }, text: 'same' })).toBeNull();
    }
    expect(nextCheck(state)).toBeNull();
  });

  test('mode: warn still fires (the host decides not to abort)', () => {
    const state = new LoopDetectorState({ mode: 'warn' });
    let detection = null;
    for (let i = 0; i < 4; i++) {
      detection = state.addAndCheck({
        toolCalls: [{ name: 'Read', input: { path: '/x' } }],
        assistantText: '',
      });
    }
    expect(detection?.detector).toBe('consecutive-identical');
  });

  test('HARNESS_LOOP_DETECTOR=off short-circuits before any check', () => {
    withEnvOff(() => {
      const state = new LoopDetectorState();
      let detection = null;
      for (let i = 0; i < 100; i++) {
        detection = state.addAndCheck({
          toolCalls: [{ name: 'Bash', input: { command: 'echo same' } }],
          assistantText: '',
        });
      }
      expect(detection).toBeNull();
    });
  });

  test('HARNESS_LOOP_DETECTOR=off also makes observeResults a no-op', () => {
    const state = new LoopDetectorState();
    withEnvOff(() => {
      primeResults(state, 8);
      driveUnproductiveRun(state, 8, 're-read');
    });
    // Env restored: the ledger stayed empty while the kill switch was on, so
    // there is nothing to fire on.
    expect(nextCheck(state)).toBeNull();
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
      restoreEnv(original);
    }
  });
});

describe('LoopDetectorState — option hardening', () => {
  test('non-positive thresholds are clamped instead of firing on every check', () => {
    // The config schema rejects these (Zod, positive ints); the embedded API is
    // plain TS, so the detector clamps rather than degenerating.
    const state = new LoopDetectorState({
      noProgressWindow: 0,
      consecutiveIdenticalThreshold: 0,
      contentChunkSize: 0,
      contentRepeatThreshold: 0,
    });
    expect(state.addAndCheck({ toolCalls: [], assistantText: '' })).toBeNull();
    expect(drive(state, { name: 'Bash', input: { command: 'ls' }, text: 'a b c' })).toBeNull();
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
    expect(detection?.reason).toContain('repeated');
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
    detection = drive(state, { name: 'Read', input: { path: '/a' }, text: 'file a' });
    detection = drive(state, {
      name: 'FileEdit',
      input: { path: '/a', old: 'x', new: 'y' },
      text: 'edited',
    });
    detection = drive(state, { name: 'Bash', input: { command: 'ls' }, text: 'a b c' });
    expect(detection).toBeNull();
    expect(nextCheck(state)).toBeNull();
  });

  test('a long productive run of mixed tools never fires', () => {
    const state = new LoopDetectorState();
    for (let i = 0; i < 40; i++) {
      const name = i % 2 === 0 ? 'Bash' : 'Read';
      expect(drive(state, { name, input: { arg: `step-${i}` }, text: `output ${i}` })).toBeNull();
    }
    expect(nextCheck(state)).toBeNull();
  });
});

function withEnvOff(fn: () => void): void {
  const original = process.env.HARNESS_LOOP_DETECTOR;
  process.env.HARNESS_LOOP_DETECTOR = 'off';
  try {
    fn();
  } finally {
    restoreEnv(original);
  }
}

function restoreEnv(original: string | undefined): void {
  if (original === undefined) {
    // biome-ignore lint/performance/noDelete: restore unset state
    delete process.env.HARNESS_LOOP_DETECTOR;
  } else {
    process.env.HARNESS_LOOP_DETECTOR = original;
  }
}
