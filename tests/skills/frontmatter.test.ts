// Shared SKILL.md frontmatter helper tests.
//
// `splitCommaList` is used by BOTH the loader read path (normalizeFrontmatterAliases)
// and the import write path (normalizeImportedFrontmatter) to turn a Claude Code
// `allowed-tools: Read, Bash(...)` comma-string into a list. It MUST be aware of
// `(...)`/`[...]` nesting: a real CC Bash pattern routinely carries a comma INSIDE
// the parens (e.g. `Bash(git log --pretty=format:%h,%an)`), and a naive
// `split(',')` shreds that into unparseable fragments that later throw in
// `parsePermissionRule` ("missing closing )") — failing the whole /skill turn.

import { describe, expect, test } from 'bun:test';
import { splitCommaList } from '../../src/skills/frontmatter.js';

describe('splitCommaList', () => {
  test('splits a plain comma list', () => {
    expect(splitCommaList('Read, Grep')).toEqual(['Read', 'Grep']);
  });

  test('does NOT split on a comma inside a Bash(...) pattern (F1)', () => {
    // The bug: a comma inside the parens of a Bash pattern must NOT be a
    // split point, or the entry shreds into 'Bash(git log --pretty=format:%h'
    // + '%an)', the first of which throws "missing closing )" downstream.
    expect(splitCommaList('Read, Bash(git log --pretty=format:%h,%an)')).toEqual([
      'Read',
      'Bash(git log --pretty=format:%h,%an)',
    ]);
  });

  test('does not split a parenthesized entry that comes first', () => {
    expect(splitCommaList('Bash(echo a,b), Read')).toEqual(['Bash(echo a,b)', 'Read']);
  });

  test('does not split commas inside [...] brackets (incl. nested parens)', () => {
    expect(splitCommaList('Glob([a,(b,c)]), Read')).toEqual(['Glob([a,(b,c)])', 'Read']);
  });

  test('trims entries and drops empties / trailing comma', () => {
    expect(splitCommaList('Read,  , Grep,')).toEqual(['Read', 'Grep']);
  });

  test('leaves an unbalanced opener as a single remainder entry (no crash)', () => {
    // An unterminated `(` means everything after the last depth-0 comma is one
    // entry — we never throw, we never split inside the (still-open) group.
    expect(splitCommaList('Read, Bash(git log,--oneline')).toEqual([
      'Read',
      'Bash(git log,--oneline',
    ]);
  });

  test('returns an empty list for an empty / whitespace string', () => {
    expect(splitCommaList('')).toEqual([]);
    expect(splitCommaList('  ,  ')).toEqual([]);
  });
});
