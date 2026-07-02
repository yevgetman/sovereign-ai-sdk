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
import { scopesOverlap } from '../../src/runtime/pathLock.js';

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
  // extglob syntax — DEAD under `noext: true` (Bun.Glob has no extglobs, so
  // parity = both deny). The `src/!(secret)/**` rows are the write-race probe
  // that DROVE noext: with default options picomatch admitted `src/pub/a.ts`
  // while pathLock judged the scope disjoint from `src/pub/**` (2026-07-01).
  ['src/!(secret)/**', 'src/pub/a.ts'],
  ['src/!(secret)/**', 'src/secret/a.ts'],
  ['+(a|b).ts', 'a.ts'],
  ['+(a|b).ts', 'c.ts'],
  ['+(a|b).ts', '+(a|b).ts'], // literal path containing extglob chars
  ['@(a|b).ts', 'a.ts'],
  ['@(a|b).ts', 'c.ts'],
  ['@(a|b).ts', '@(a|b).ts'],
  ['*(a).ts', '.ts'],
  ['?(a).ts', 'a.ts'],
  ['?(a).ts', '.ts'],
  ['?(a).ts', '?(a).ts'],
  // negated character classes — `posix: true` fixed the [!a] inversion
  // (without it picomatch admitted 'ax' and denied 'bx': exactly backwards)
  ['[!a]x', 'ax'],
  ['[!a]x', 'bx'],
  ['[^a]x', 'ax'],
  ['[^a]x', 'bx'],
  // brace range / bare-globstar-suffix / POSIX class — the AGREEING side of
  // classes whose other side is a pinned deviation below
  ['{1..3}.ts', '4.ts'],
  ['**.ts', 'a.ts'],
  ['[[:alpha:]]x', '1x'],
  // extglob variant of the !(secret) literal-dir deviation, agreeing side
  ['!(secret)', 'pub'],
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

// ---------------------------------------------------------------------------
// Documented deviations from Bun.Glob (2026-07-01, Task 2.2 review fix).
//
// After `noext: true` + `posix: true`, these are the KNOWN residual rows where
// picomatch (what we ship) disagrees with Bun.Glob (what the gate was reviewed
// against). We deliberately do NOT force parity — each row is safe by one of
// two arguments, keyed to src/runtime/pathLock.ts's prefix collapse
// (GLOB_CHARS = /[*?[\]{}]/ → the glob's containing directory before its
// first wildcard; leading wildcard → '' = whole-tree lock):
//
//  - LOCK-COVERED (wider than Bun, but every admitted path falls inside the
//    path-lock's collapsed prefix): scopes carrying these globs over-serialize
//    against siblings; an admission can never race a task the lock judged
//    disjoint. Costs parallelism, never correctness.
//  - RESTRICTIVE-ONLY (narrower than Bun): the gate denies a write Bun would
//    have admitted — fails closed at the permission layer, never widens.
//
// Mirrors the GlobTool symlink deviation pin (tests/tools/globTool.test.ts):
// assert the behavior we ship so a dependency change is noticed. Both engines
// are asserted so the suite also fails loudly if a divergence silently CLOSES
// (then the row belongs in the parity table above).
const DEVIATION_TABLE: ReadonlyArray<
  readonly [glob: string, path: string, bun: boolean, pico: boolean, why: string]
> = [
  // -- LOCK-COVERED (picomatch admits, Bun denied; `{`/`[`/`*` ∈ GLOB_CHARS
  //    so each glob collapses to a lock prefix containing every admission) --
  [
    '{1..3}.ts',
    '2.ts',
    false,
    true,
    'brace RANGE expands in picomatch only; `{` → whole-tree lock',
  ],
  [
    '{a}.ts',
    '{a}.ts',
    false,
    true,
    'single-member brace: Bun expands to a.ts, picomatch also matches the literal; `{` → whole-tree lock',
  ],
  [
    'a{b.ts',
    'a{b.ts',
    false,
    true,
    'unmatched brace: picomatch falls back to literal, Bun matches nothing; `{` → whole-tree lock',
  ],
  [
    './src/**',
    'src/a.ts',
    false,
    true,
    "`./`-prefix: picomatch normalizes, Bun does not; pathLock normalizes the prefix to 'src', covering the admission",
  ],
  [
    '**.ts',
    'a/b.ts',
    false,
    true,
    'bare `**` with a suffix crosses `/` in picomatch, acts like `*.ts` in Bun; leading `*` → whole-tree lock',
  ],
  [
    '[[:alpha:]]x',
    'ax',
    false,
    true,
    'POSIX class enabled by posix:true, unsupported in Bun; leading `[` → whole-tree lock',
  ],
  [
    '*(a).ts',
    'a.ts',
    false,
    true,
    'noext remnant: picomatch reads `*` + literal-ish suffix, Bun (no extglobs) matches nothing; leading `*` → whole-tree lock',
  ],
  // -- RESTRICTIVE-ONLY (Bun admitted, picomatch denies → fails closed) --
  [
    '{a}.ts',
    'a.ts',
    true,
    false,
    'single-member brace: Bun expands {a}→a, picomatch (posix) does not',
  ],
  [
    'src/!(secret)/**',
    'src/!(secret)/a.ts',
    true,
    false,
    'a directory literally NAMED `!(secret)`: Bun matches it verbatim, picomatch under noext denies',
  ],
  [
    '!(secret)',
    'secret',
    true,
    false,
    'Bun treats the dead extglob as matching; picomatch under noext denies',
  ],
  [
    '*(a).ts',
    'x(a).ts',
    true,
    false,
    'Bun (no extglobs) reads `*` + literal `(a).ts`; picomatch under noext denies',
  ],
];

describe('write-scope glob documented deviations (picomatch ≠ Bun.Glob, pinned)', () => {
  for (const [glob, path, bun, pico, why] of DEVIATION_TABLE) {
    test(`'${glob}' vs '${path}' — Bun ${bun}, shipped ${pico} (${why})`, () => {
      expect(new Bun.Glob(glob).match(path)).toBe(bun);
      expect(picomatch(glob, WRITE_SCOPE_PICOMATCH_OPTIONS)(path)).toBe(pico);
    });
  }
});

// ---------------------------------------------------------------------------
// pathLock no-clash composite (extglob write-race regression, 2026-07-01).
// The CRITICAL finding behind `noext: true`: pathLock's GLOB_CHARS does not
// treat extglob characters as wildcards, so `src/!(secret)/**` collapses to
// the LITERAL prefix `src/!(secret)` and is judged DISJOINT from `src/pub/**`
// — the two scopes run in PARALLEL. If the write-scope matcher then admitted
// `src/pub/a.ts` under the extglob scope (as picomatch's default extglob
// support did), two "disjoint" write-capable tasks could race one file. With
// the shipped options the extglob is dead: no wider-than-lock admission.
describe('pathLock no-clash composite (write scope ⊆ collapsed lock prefix)', () => {
  test("pathLock judges 'src/!(secret)/**' and 'src/pub/**' disjoint (the race setup)", () => {
    expect(
      scopesOverlap(
        { kind: 'globs', globs: ['src/!(secret)/**'] },
        { kind: 'globs', globs: ['src/pub/**'] },
      ),
    ).toBe(false);
  });

  test("shipped matcher does NOT admit 'src/pub/a.ts' under 'src/!(secret)/**' (extglob dead ⇒ no race)", () => {
    expect(picomatch('src/!(secret)/**', WRITE_SCOPE_PICOMATCH_OPTIONS)('src/pub/a.ts')).toBe(
      false,
    );
  });
});
