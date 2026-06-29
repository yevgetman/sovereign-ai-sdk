// Phase 13.3 — unit tests for the pure stall / no-op detector.

import { describe, expect, test } from 'bun:test';
import { type TurnSummary, detectStall } from '../../src/util/stall.js';

function turn(partial: Partial<TurnSummary> = {}): TurnSummary {
  return {
    fileEditCount: 0,
    memoryWriteCount: 0,
    decisionCount: 0,
    toolErrorCount: 0,
    toolCallCount: 0,
    ...partial,
  };
}

describe('detectStall', () => {
  test('no-op when window has any productive activity', () => {
    expect(detectStall([turn({ fileEditCount: 1 }), turn(), turn()])).toEqual({ stalled: false });
    expect(detectStall([turn(), turn({ memoryWriteCount: 1 }), turn()])).toEqual({
      stalled: false,
    });
    expect(detectStall([turn(), turn(), turn({ decisionCount: 1 })])).toEqual({ stalled: false });
  });

  test('three consecutive empty turns → stalled with reason', () => {
    const r = detectStall([turn(), turn(), turn()]);
    expect(r.stalled).toBe(true);
    if (r.stalled) {
      expect(r.reason).toContain('no tool calls');
    }
  });

  test('three consecutive turns with only tool errors → stalled with errors reason', () => {
    const r = detectStall([
      turn({ toolCallCount: 2, toolErrorCount: 2 }),
      turn({ toolCallCount: 1, toolErrorCount: 1 }),
      turn({ toolCallCount: 3, toolErrorCount: 3 }),
    ]);
    expect(r.stalled).toBe(true);
    if (r.stalled) {
      expect(r.reason).toContain('repeated tool errors');
    }
  });

  test('window shorter than 3 → never stalled', () => {
    expect(detectStall([turn(), turn()]).stalled).toBe(false);
    expect(detectStall([]).stalled).toBe(false);
    expect(detectStall([turn()]).stalled).toBe(false);
  });

  test('detector reads only the most recent 3 turns when window is longer', () => {
    // Active turn at the start, then 3 empty — should still be stalled
    const r = detectStall([turn({ fileEditCount: 5 }), turn(), turn(), turn()]);
    expect(r.stalled).toBe(true);
  });

  // ux-fixes round 2 — research-only turns (read-only tool calls, no
  // edits or memory writes) must count as progress so the stall warning
  // doesn't fire while the model is exploring the codebase.

  test('three turns of read-only tool calls → NOT stalled (research is progress)', () => {
    // e.g., FileRead/Bash/Grep — toolCallCount > 0, no errors, no edits.
    const r = detectStall([
      turn({ toolCallCount: 4 }),
      turn({ toolCallCount: 2 }),
      turn({ toolCallCount: 3 }),
    ]);
    expect(r.stalled).toBe(false);
  });

  test('tool calls with some failures and some successes → NOT stalled', () => {
    // 1 error out of 3 calls per turn — still making progress.
    const r = detectStall([
      turn({ toolCallCount: 3, toolErrorCount: 1 }),
      turn({ toolCallCount: 3, toolErrorCount: 1 }),
      turn({ toolCallCount: 3, toolErrorCount: 1 }),
    ]);
    expect(r.stalled).toBe(false);
  });

  test('mixed turns: 2 research turns + 1 truly empty turn → NOT stalled', () => {
    const r = detectStall([turn({ toolCallCount: 5 }), turn(), turn({ toolCallCount: 2 })]);
    expect(r.stalled).toBe(false);
  });
});
