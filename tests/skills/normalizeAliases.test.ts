// F9 — the `allowed-tools` → `allowedTools` alias + comma-string split must
// live in ONE place. The loader's read path and the import write path both
// apply it; before F9 the import path re-implemented the rule, risking drift.
// This pins that the import normalizer delegates to the SHARED loader transform
// for the field changes: for the same input, both produce the same canonical
// `allowedTools` — including the F1 comma-in-parens case that only stays correct
// when both share the depth-aware splitter.

import { describe, expect, test } from 'bun:test';
import { normalizeImportedFrontmatter } from '@yevgetman/sov-sdk/skills/install';
import { normalizeFrontmatterAliases } from '@yevgetman/sov-sdk/skills/loader';

function loaderAllowedTools(raw: unknown): unknown {
  const out = normalizeFrontmatterAliases(raw);
  return (out as Record<string, unknown>).allowedTools;
}

describe('shared alias/split normalization (F9)', () => {
  test('import path produces the same allowedTools as the loader for a CC comma string', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      'allowed-tools': 'Read, Grep, Bash(git status)',
    };
    const imported = normalizeImportedFrontmatter(raw).frontmatter.allowedTools;
    expect(imported).toEqual(loaderAllowedTools(raw));
    expect(imported).toEqual(['Read', 'Grep', 'Bash(git status)']);
  });

  test('the comma-in-parens entry is preserved identically by both surfaces (F1+F9)', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      'allowed-tools': 'Read, Bash(git log --pretty=format:%h,%an)',
    };
    const imported = normalizeImportedFrontmatter(raw).frontmatter.allowedTools;
    expect(imported).toEqual(loaderAllowedTools(raw));
    expect(imported).toEqual(['Read', 'Bash(git log --pretty=format:%h,%an)']);
  });

  test('native allowedTools wins over allowed-tools on both surfaces (no clobber)', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      allowedTools: ['Read', 'Grep'],
      'allowed-tools': 'Bash(rm -rf /)',
    };
    const imported = normalizeImportedFrontmatter(raw).frontmatter.allowedTools;
    expect(imported).toEqual(loaderAllowedTools(raw));
    expect(imported).toEqual(['Read', 'Grep']);
  });

  test('import still records the conversion notes on top of the shared transform', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      'allowed-tools': 'Read, Grep',
    };
    const result = normalizeImportedFrontmatter(raw);
    expect(result.converted.some((c) => c.includes('allowed-tools'))).toBe(true);
    expect(result.converted.some((c) => c.includes('comma'))).toBe(true);
    // The hyphenated key must not survive into the canonical output.
    expect('allowed-tools' in result.frontmatter).toBe(false);
  });
});
