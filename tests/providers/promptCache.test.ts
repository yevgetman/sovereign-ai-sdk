// Direct unit tests for the shared prompt-caching policy module — the one
// place that decides WHERE cache breakpoints go for both the Anthropic
// transport and the OpenAI-format transport's openrouter lane. Pure
// arithmetic: no providers, no wire shapes, no network.
//
// Spec: specs/2026-08-25-openrouter-cache-and-image-passthrough-design.md §2.2
// (item 4 — "reuse, do not fork, the policy").

import { describe, expect, test } from 'bun:test';
import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';
import {
  MAX_CACHE_BREAKPOINTS,
  RECENT_MESSAGE_CACHE_WINDOW,
  findLastCacheableSegment,
  lastIndexWhere,
  recentMessageCacheFrom,
} from '@yevgetman/sov-sdk/providers/promptCache';

/** Terse segment builder — `!` suffix marks a cacheable segment. */
function segments(...spec: string[]): SystemSegment[] {
  return spec.map((s) => ({ text: s.replace(/!$/, ''), cacheable: s.endsWith('!') }));
}

describe('promptCache policy constants', () => {
  test('the recent-message window is 3 messages', () => {
    expect(RECENT_MESSAGE_CACHE_WINDOW).toBe(3);
  });

  test("the breakpoint budget is Anthropic's per-request limit of 4", () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);
  });

  test('the budget covers 1 system marker plus the whole recent window', () => {
    expect(1 + RECENT_MESSAGE_CACHE_WINDOW).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });
});

describe('recentMessageCacheFrom', () => {
  test('returns 0 for an empty history (nothing to mark, no negative index)', () => {
    expect(recentMessageCacheFrom(0)).toBe(0);
  });

  test('clamps at 0 for histories shorter than the window', () => {
    expect(recentMessageCacheFrom(1)).toBe(0);
    expect(recentMessageCacheFrom(2)).toBe(0);
  });

  test('returns 0 when the history is exactly the window (every message eligible)', () => {
    expect(recentMessageCacheFrom(3)).toBe(0);
  });

  test('returns the index of the first of the last 3 messages for a long history', () => {
    expect(recentMessageCacheFrom(10)).toBe(7);
  });

  test('the eligible window is never wider than RECENT_MESSAGE_CACHE_WINDOW', () => {
    for (const count of [0, 1, 2, 3, 4, 7, 10, 250]) {
      expect(count - recentMessageCacheFrom(count)).toBeLessThanOrEqual(
        RECENT_MESSAGE_CACHE_WINDOW,
      );
    }
  });
});

describe('findLastCacheableSegment', () => {
  test('returns -1 for no segments at all', () => {
    expect(findLastCacheableSegment([])).toBe(-1);
  });

  test('returns -1 when no segment is cacheable', () => {
    expect(findLastCacheableSegment(segments('a', 'b', 'c'))).toBe(-1);
  });

  test('finds a cacheable first segment', () => {
    expect(findLastCacheableSegment(segments('a!', 'b', 'c'))).toBe(0);
  });

  test('finds a cacheable middle segment', () => {
    expect(findLastCacheableSegment(segments('a', 'b!', 'c'))).toBe(1);
  });

  test('finds a cacheable last segment', () => {
    expect(findLastCacheableSegment(segments('a', 'b', 'c!'))).toBe(2);
  });

  test('picks the LAST cacheable segment when several are cacheable', () => {
    expect(findLastCacheableSegment(segments('a!', 'b!', 'c'))).toBe(1);
    expect(findLastCacheableSegment(segments('a!', 'b!', 'c!'))).toBe(2);
  });

  test('a single cacheable segment is index 0', () => {
    expect(findLastCacheableSegment(segments('only!'))).toBe(0);
  });
});

describe('lastIndexWhere', () => {
  test('returns -1 for an empty list', () => {
    expect(lastIndexWhere([], () => true)).toBe(-1);
  });

  test('returns -1 when nothing matches', () => {
    expect(lastIndexWhere([1, 2, 3], (n) => n > 10)).toBe(-1);
  });

  test('returns the last matching index, not the first', () => {
    expect(lastIndexWhere([1, 2, 3, 4], (n) => n % 2 === 0)).toBe(3);
  });

  test('matches at the first position when it is the only match', () => {
    expect(lastIndexWhere(['x', 'y', 'z'], (s) => s === 'x')).toBe(0);
  });

  test('matches at the last position', () => {
    expect(lastIndexWhere(['x', 'y', 'z'], (s) => s === 'z')).toBe(2);
  });

  test('works over object items (the shape both transports actually pass)', () => {
    const blocks = [{ type: 'text' }, { type: 'image' }, { type: 'text' }, { type: 'image' }];
    expect(lastIndexWhere(blocks, (b) => b.type === 'text')).toBe(2);
  });

  test('skips holes — an absent item cannot carry a marker', () => {
    // biome-ignore lint/suspicious/noSparseArray: a hole is exactly the case under test.
    const sparse: (string | undefined)[] = ['a', , 'b', ,];
    expect(lastIndexWhere(sparse, () => true)).toBe(2);
  });

  test('skips a literal null element (never handed to the predicate)', () => {
    const withNull: (string | null)[] = ['a', 'b', null];
    expect(
      lastIndexWhere(withNull, (item) => {
        // a nullish element must never reach the predicate
        expect(item).not.toBeNull();
        return true;
      }),
    ).toBe(1);
  });

  test('skips trailing null AND undefined elements alike', () => {
    const nullish: (number | null | undefined)[] = [1, 2, null, undefined, null];
    expect(lastIndexWhere(nullish, () => true)).toBe(1);
  });
});
