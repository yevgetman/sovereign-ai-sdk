// Phase 10.5 part 2c — formatCompareGrid table renderer. Pure: takes
// a list of GoldenResults (with `provider` set) and the lane order;
// returns a multi-line string. We don't exercise the spawn loop here
// — the runner glue is small enough that a smoke run via `sov eval
// run --compare` covers it.

import { describe, expect, test } from 'bun:test';
import { formatCompareGrid } from '../../src/cli/evalRun.js';
import type { GoldenResult } from '../../src/eval/types.js';

function result(over: Partial<GoldenResult> = {}): GoldenResult {
  return {
    id: 'g1',
    name: 'g1',
    provider: 'anthropic',
    pass: true,
    durationMs: 1500,
    exitCode: 0,
    assertionResults: [],
    transcript: '',
    stderr: '',
    ...over,
  };
}

describe('formatCompareGrid', () => {
  test('renders a grid with one row per golden and one column per provider', () => {
    const grid = formatCompareGrid(
      [
        result({ id: 'g1', provider: 'anthropic', pass: true, durationMs: 1200 }),
        result({ id: 'g1', provider: 'ollama', pass: false, durationMs: 4500 }),
        result({ id: 'g2', provider: 'anthropic', pass: true, durationMs: 800 }),
        result({ id: 'g2', provider: 'ollama', pass: true, durationMs: 3000 }),
      ],
      ['anthropic', 'ollama'],
    );
    const lines = grid.trim().split('\n');
    // Header + separator + 2 rows.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('golden');
    expect(lines[0]).toContain('anthropic');
    expect(lines[0]).toContain('ollama');
    expect(lines[2]).toContain('g1');
    expect(lines[2]).toMatch(/✓\s+1\.2s.*✗\s+4\.5s/);
    expect(lines[3]).toContain('g2');
    expect(lines[3]).toMatch(/✓\s+0\.8s.*✓\s+3\.0s/);
  });

  test('renders an em-dash placeholder when a (golden, provider) cell has no result', () => {
    const grid = formatCompareGrid(
      [result({ id: 'g1', provider: 'anthropic', pass: true })],
      ['anthropic', 'ollama'],
    );
    const lines = grid.trim().split('\n');
    // The g1 row should have the anthropic checkmark and an em-dash for ollama.
    expect(lines[2]).toContain('—');
  });

  test('returns empty string when no results or no providers', () => {
    expect(formatCompareGrid([], ['anthropic'])).toBe('');
    expect(formatCompareGrid([result()], [])).toBe('');
  });

  test('preserves golden order from the results list', () => {
    const grid = formatCompareGrid(
      [
        result({ id: 'zeta', provider: 'a' }),
        result({ id: 'alpha', provider: 'a' }),
        result({ id: 'mid', provider: 'a' }),
      ],
      ['a'],
    );
    const lines = grid.trim().split('\n');
    expect(lines[2]).toContain('zeta');
    expect(lines[3]).toContain('alpha');
    expect(lines[4]).toContain('mid');
  });
});
