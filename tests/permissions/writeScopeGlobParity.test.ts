// Empirical Bun.Glob ↔ picomatch parity for the write-scope permission gate
// (Task 2.2, SDK consumable packaging). The shipped matcher in
// src/permissions/writeScope.ts is picomatch-only (Node-compatible); this suite
// runs under `bun test`, where Bun.Glob is still available, and GENERATES the
// expected outcome of every row from `new Bun.Glob(glob).match(path)` at test
// time — then asserts picomatch, with the EXACT production options
// (WRITE_SCOPE_PICOMATCH_OPTIONS), agrees. The parity claim is therefore
// empirical, not assumed: a behavior change in either engine, or drift in the
// production options, fails this suite.
//
// Security context: matchesGlob() enforces a task's declared `writes` scope
// over FileWrite/FileEdit paths. A matcher MORE permissive than Bun.Glob
// silently widens a security boundary; one MORE restrictive breaks declared
// scopes (denies in-scope writes). Both directions are bugs, so every row
// asserts exact agreement rather than one-sided containment.

import { describe, expect, test } from 'bun:test';
import picomatch from 'picomatch';
import { WRITE_SCOPE_PICOMATCH_OPTIONS } from '../../src/permissions/writeScope.js';

/** (glob, cwd-relative path) rows. Expectations are generated from Bun.Glob at
 *  test time — no hand-maintained expected column to rot. Rows cover: globstar
 *  subtrees, single-star not crossing `/`, dotfiles under `*`/`**`/`.*`,
 *  trailing-slash patterns, case-sensitivity probes, brace expansion, `?` and
 *  character classes, literal (wildcard-free) patterns, and the bare-base-dir
 *  edge (`src/**` vs `src`) that forced `strictSlashes: true`. */
const PARITY_TABLE: ReadonlyArray<readonly [glob: string, path: string]> = [
  // globstar subtrees
  ['src/**', 'src/a/b.ts'],
  ['src/**', 'src/a.ts'],
  ['src/**', 'src'], // bare base dir — Bun.Glob: false (needs strictSlashes)
  ['src/**', 'srcx/a.ts'],
  ['src/**/*.ts', 'src/a.ts'], // ** matches zero segments
  ['src/**/*.ts', 'src/a/b.ts'],
  ['src/**/*.ts', 'other/a.ts'],
  ['a/**/b', 'a/b'],
  ['a/**/b', 'a/x/b'],
  ['a/**/b', 'a/x/y/b'],
  ['**', 'a'],
  ['**', 'a/b/c.ts'],
  // single star must NOT cross '/'
  ['*.ts', 'a.ts'],
  ['*.ts', 'a/b.ts'],
  ['**/*.ts', 'a/b.ts'],
  ['**/*.ts', 'a.ts'],
  ['docs/*.md', 'docs/a.md'],
  ['docs/*.md', 'docs/sub/a.md'],
  ['src/*', 'src'],
  // dotfiles — Bun.Glob matches them with * / ** (the `dot: true` driver)
  ['**', '.env'],
  ['**', '.git/config'],
  ['*', '.env'],
  ['*', 'a.ts'],
  ['.*', '.env'],
  ['.*', 'a.ts'],
  ['src/**', 'src/.env'],
  ['src/*', 'src/.env'],
  ['**/*.ts', '.hidden/a.ts'],
  // trailing '/' handling
  ['src/', 'src'],
  ['src/', 'src/a.ts'],
  ['src/**/', 'src/a'],
  ['src/**/', 'src/a/'],
  ['**/', 'a/'],
  ['**/', 'a'],
  // case-sensitivity probes
  ['SRC/**', 'src/a.ts'],
  ['src/**', 'SRC/a.ts'],
  ['*.TS', 'a.ts'],
  // brace expansion, ?, character classes
  ['{a,b}/*.ts', 'a/x.ts'],
  ['{a,b}/*.ts', 'c/x.ts'],
  ['a?c', 'abc'],
  ['a?c', 'a/c'],
  ['[ab]x', 'ax'],
  ['[ab]x', 'cx'],
  // literal (wildcard-free) patterns — the bare-directory fallback in
  // matchesGlob() handles subtree admission; the RAW matchers agree it's false
  ['migrations', 'migrations'],
  ['migrations', 'migrations/001.sql'],
  ['a.ts', 'a.ts'],
  ['a.ts', 'b.ts'],
];

describe('write-scope glob parity (Bun.Glob ↔ picomatch)', () => {
  for (const [glob, path] of PARITY_TABLE) {
    test(`'${glob}' vs '${path}'`, () => {
      const expected = new Bun.Glob(glob).match(path);
      const actual = picomatch(glob, WRITE_SCOPE_PICOMATCH_OPTIONS)(path);
      expect(actual).toBe(expected);
    });
  }

  // Anchors — pin the two Bun.Glob behaviors that DROVE the option choice, as
  // literal expectations. The dynamic table above proves the engines agree;
  // these prove the agreed-upon behavior is the one the security gate was
  // reviewed against. If Bun.Glob itself ever changes, these fail loudly
  // instead of the table silently re-baselining.
  test('anchor: Bun.Glob matches dotfiles with * and ** (drives dot: true)', () => {
    expect(new Bun.Glob('*').match('.env')).toBe(true);
    expect(new Bun.Glob('**').match('.git/config')).toBe(true);
  });

  test("anchor: Bun.Glob does NOT match the bare base dir with 'dir/**' (drives strictSlashes: true)", () => {
    expect(new Bun.Glob('src/**').match('src')).toBe(false);
  });
});
