// Phase 13.3 — unit tests for the pure stall / no-op detector.

import { describe, expect, test } from 'bun:test';
import { type TurnSummary, detectStall } from '../../src/review/stall.js';

function turn(partial: Partial<TurnSummary> = {}): TurnSummary {
  return {
    fileEditCount: 0,
    memoryWriteCount: 0,
    decisionCount: 0,
    toolErrorCount: 0,
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
      expect(r.reason).toContain('no edits');
    }
  });

  test('three consecutive turns with only tool errors → stalled with errors reason', () => {
    const r = detectStall([
      turn({ toolErrorCount: 2 }),
      turn({ toolErrorCount: 1 }),
      turn({ toolErrorCount: 3 }),
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
});
