// Validates that every visual scenario (`.harness/visual/scenarios/*.tape`)
// is well-formed:
//   1. Sources the preamble.
//   2. Declares an Output to `_trash/<name>.gif` (VHS requires Output;
//      the GIF is throwaway).
//   3. Includes a Screenshot directive pointing at
//      `.harness/visual/output/<name>.png` — that's the file the agent reads.
//   4. Ends with a clean `/quit` so sov exits cleanly.
//
// Per the convention doc (docs/conventions/visual-tui-qa.md), these are
// scenario contracts, not runtime tests — we do NOT actually run VHS here
// (that's a 10-30s per scenario cost we don't want in `bun run test`).

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCENARIOS_DIR = join(REPO_ROOT, '.harness', 'visual', 'scenarios');

type Scenario = {
  name: string;
  body: string;
};

function listScenarios(): Scenario[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.tape') && !f.startsWith('_'))
    .sort()
    .map((f) => ({
      name: f.replace(/\.tape$/, ''),
      body: readFileSync(join(SCENARIOS_DIR, f), 'utf8'),
    }));
}

describe('visual scenarios', () => {
  const scenarios = listScenarios();

  test('at least one scenario exists', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const { name, body } of scenarios) {
    describe(name, () => {
      test('sources the preamble', () => {
        expect(body).toContain('Source .harness/visual/scenarios/_preamble.tape');
      });

      test('declares Output to _trash', () => {
        const expected = `Output .harness/visual/output/_trash/${name}.gif`;
        expect(body).toContain(expected);
      });

      test('captures a Screenshot to the canonical path', () => {
        const expected = `Screenshot .harness/visual/output/${name}.png`;
        expect(body).toContain(expected);
      });

      test('Screenshot is followed by a Sleep buffer (avoids capturing next-input keystrokes)', () => {
        // VHS' Screenshot directive is fast but not strictly synchronous
        // with subsequent Type/Enter directives; without a Sleep buffer
        // the screenshot can capture the next keystroke landing. Every
        // scenario must Sleep at least 200ms after each Screenshot.
        const screenshotPattern =
          /Screenshot\s+\.harness\/visual\/output\/[\w-]+\.png[^\n]*\n\s*Sleep\s+(\d+)(ms|s)/g;
        const matches = [...body.matchAll(screenshotPattern)];
        const screenshotCount = (body.match(/^Screenshot\s+/gm) ?? []).length;
        expect(matches.length).toBe(screenshotCount);
        for (const m of matches) {
          const value = Number(m[1]);
          const unit = m[2];
          const ms = unit === 's' ? value * 1000 : value;
          expect(ms).toBeGreaterThanOrEqual(200);
        }
      });

      test('has an explicit exit (/quit or Escape) so sov exits cleanly', () => {
        // Full-sov scenarios use `/quit`; `sov config` standalone
        // scenarios use `Escape` on the root menu (configOnly mode
        // exits when no modal is open). Either is acceptable.
        const hasQuit = body.includes('Type "/quit"');
        const hasEscape = /\bEscape\b/.test(body);
        expect(hasQuit || hasEscape).toBe(true);
      });
    });
  }
});
