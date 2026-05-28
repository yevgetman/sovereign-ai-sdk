// Validates that every visual scenario (`.harness/visual/scenarios/*.tape`)
// is well-formed:
//   1. Sources the preamble.
//   2. Declares an Output to `_trash/<name>.gif` (VHS requires Output;
//      the GIF is throwaway).
//   3. Includes one or more Screenshot directives:
//      - Single-shot pattern: `.harness/visual/output/<name>.png`
//      - Multi-shot pattern:  `.harness/visual/output/<name>-NN-<step>.png`
//        (NN = two-digit ordinal; <step> = kebab-case step description)
//      Scenarios may NOT mix the two patterns within a single tape.
//   4. Every Screenshot is followed by a Sleep of ≥200ms (buffer against
//      capturing the next keystroke).
//   5. Ends with a clean `/quit` or `Escape` so sov exits cleanly.
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

/** Extract every `Screenshot <path>` line from a tape, with the path. */
function extractScreenshotPaths(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*Screenshot\s+(\S+)\s*$/);
    if (m) out.push(m[1] as string);
  }
  return out;
}

const SINGLE_SHOT_RE = (name: string) => new RegExp(`^\\.harness/visual/output/${name}\\.png$`);
const MULTI_SHOT_RE = (name: string) =>
  new RegExp(`^\\.harness/visual/output/${name}-\\d{2}-[a-z0-9][a-z0-9-]*\\.png$`);

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

      test('all Screenshot paths follow the naming convention', () => {
        const paths = extractScreenshotPaths(body);
        expect(paths.length).toBeGreaterThan(0);

        const singleRe = SINGLE_SHOT_RE(name);
        const multiRe = MULTI_SHOT_RE(name);

        const singleMatches = paths.filter((p) => singleRe.test(p));
        const multiMatches = paths.filter((p) => multiRe.test(p));
        const unmatched = paths.filter((p) => !singleRe.test(p) && !multiRe.test(p));

        // No paths outside the two allowed patterns.
        expect(unmatched).toEqual([]);

        // A scenario uses EITHER the single-shot pattern (1 PNG named
        // <name>.png) OR the multi-shot pattern (multiple PNGs named
        // <name>-NN-<step>.png). Mixing is rejected.
        if (paths.length === 1) {
          // 1 screenshot — either pattern is OK in theory but the
          // canonical form for a single capture is the bare name.
          expect(singleMatches.length).toBe(1);
        } else {
          // 2+ screenshots — every path must be in the multi pattern,
          // and ordinals must be sequential from 01.
          expect(multiMatches.length).toBe(paths.length);
          const ordinals = paths.map((p) => {
            const m = p.match(/-(\d{2})-/);
            return m ? Number(m[1]) : -1;
          });
          for (let i = 0; i < ordinals.length; i++) {
            expect(ordinals[i]).toBe(i + 1);
          }
        }
      });

      test('every Screenshot is followed by a Sleep ≥200ms', () => {
        const screenshotPattern = /Screenshot\s+\S+[^\n]*\n\s*Sleep\s+(\d+)(ms|s)/g;
        const matches = [...body.matchAll(screenshotPattern)];
        const screenshotCount = (body.match(/^\s*Screenshot\s+/gm) ?? []).length;
        expect(matches.length).toBe(screenshotCount);
        for (const m of matches) {
          const value = Number(m[1]);
          const unit = m[2];
          const ms = unit === 's' ? value * 1000 : value;
          expect(ms).toBeGreaterThanOrEqual(200);
        }
      });

      test('has an explicit exit (/quit or Escape) so sov exits cleanly', () => {
        const hasQuit = body.includes('Type "/quit"');
        const hasEscape = /\bEscape\b/.test(body);
        expect(hasQuit || hasEscape).toBe(true);
      });
    });
  }
});
