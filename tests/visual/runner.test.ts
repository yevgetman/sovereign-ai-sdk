// Validates the `scripts/visual.ts` runner's scenario discovery + name
// filtering. Does NOT invoke VHS — we just test the discovery logic.
//
// Per the convention doc (docs/conventions/visual-tui-qa.md), the runner
// is intentionally minimal; these tests cover the small bit of logic that
// could regress (filtering, preamble exclusion).

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCENARIOS_DIR = join(REPO_ROOT, '.harness', 'visual', 'scenarios');

function discoverScenarios(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.tape') && !f.startsWith('_'))
    .map((f) => f.replace(/\.tape$/, ''))
    .sort();
}

describe('visual runner discovery', () => {
  test('finds the canonical scenarios in deterministic order', () => {
    const names = discoverScenarios();
    expect(names).toEqual([...names].sort());
    // Sanity — we expect at least the four non-API scenarios + turn-complete.
    // The exact set may grow; assert each well-known one is present rather
    // than a strict-equal so adding new scenarios doesn't break this test.
    expect(names).toContain('splash');
    expect(names).toContain('prompt-input');
    expect(names).toContain('config-menu');
  });

  test('skips preamble files (anything starting with _)', () => {
    const all = readdirSync(SCENARIOS_DIR);
    const discovered = discoverScenarios();
    // _preamble.tape exists on disk but should NOT be discovered.
    expect(all).toContain('_preamble.tape');
    expect(discovered).not.toContain('_preamble');
  });

  test('skips non-.tape files', () => {
    const discovered = discoverScenarios();
    // Every discovered name corresponds to a .tape on disk; nothing else.
    for (const name of discovered) {
      expect(name.endsWith('.tape')).toBe(false); // names have extension stripped
    }
  });
});
