// Picker navigation primitives. The full raw-mode loop is covered by
// integration tests via slash commands; this file pins the pure
// stepSelection / findFirstSelectable / findLastSelectable helpers
// since they're load-bearing for keyboard correctness.

import { describe, expect, test } from 'bun:test';
import { __test__ } from '../../src/ui/picker.js';

const { stepSelection, findFirstSelectable, findLastSelectable } = __test__;

type Item = { label: string; value: string; disabled?: boolean };

function items(specs: (string | { label: string; disabled: boolean })[]): Item[] {
  return specs.map((s) =>
    typeof s === 'string'
      ? { label: s, value: s }
      : { label: s.label, value: s.label, disabled: s.disabled },
  );
}

describe('findFirstSelectable / findLastSelectable', () => {
  test('returns first/last index when no items disabled', () => {
    const list = items(['a', 'b', 'c']);
    expect(findFirstSelectable(list)).toBe(0);
    expect(findLastSelectable(list)).toBe(2);
  });

  test('skips leading disabled items', () => {
    const list = items([{ label: 'a', disabled: true }, 'b', 'c']);
    expect(findFirstSelectable(list)).toBe(1);
  });

  test('skips trailing disabled items', () => {
    const list = items(['a', 'b', { label: 'c', disabled: true }]);
    expect(findLastSelectable(list)).toBe(1);
  });

  test('returns -1 when all items disabled', () => {
    const list = items([
      { label: 'a', disabled: true },
      { label: 'b', disabled: true },
    ]);
    expect(findFirstSelectable(list)).toBe(-1);
    expect(findLastSelectable(list)).toBe(-1);
  });
});

describe('stepSelection', () => {
  test('moves down by one in flat list', () => {
    const list = items(['a', 'b', 'c']);
    expect(stepSelection(list, 0, 1)).toBe(1);
    expect(stepSelection(list, 1, 1)).toBe(2);
  });

  test('wraps around at the bottom', () => {
    const list = items(['a', 'b', 'c']);
    expect(stepSelection(list, 2, 1)).toBe(0);
  });

  test('wraps around at the top', () => {
    const list = items(['a', 'b', 'c']);
    expect(stepSelection(list, 0, -1)).toBe(2);
  });

  test('skips disabled rows in the direction of travel', () => {
    const list = items(['a', { label: 'b', disabled: true }, 'c']);
    expect(stepSelection(list, 0, 1)).toBe(2);
    expect(stepSelection(list, 2, -1)).toBe(0);
  });

  test('paged stepping (delta > 1) lands on a selectable row', () => {
    const list = items(['a', 'b', 'c', 'd', 'e']);
    expect(stepSelection(list, 0, 3)).toBe(3);
    expect(stepSelection(list, 4, -3)).toBe(1);
  });
});
