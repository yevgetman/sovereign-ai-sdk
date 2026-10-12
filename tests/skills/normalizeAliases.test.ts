// Import and direct loading preserve portable pre-approval separately from
// native tool restrictions, using the same list parser.

import { describe, expect, test } from 'bun:test';
import { normalizeImportedFrontmatter } from '@yevgetman/sov-sdk/skills/install';
import { normalizeFrontmatterAliases } from '@yevgetman/sov-sdk/skills/loader';

function loaderAllowedTools(raw: unknown): unknown {
  const out = normalizeFrontmatterAliases(raw);
  return (out as Record<string, unknown>)['allowed-tools'];
}

describe('shared alias/split normalization (F9)', () => {
  test('import path produces the same allowedTools as the loader for a CC comma string', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      'allowed-tools': 'Read, Grep, Bash(git status)',
    };
    const imported = normalizeImportedFrontmatter(raw).frontmatter['allowed-tools'];
    expect(imported).toEqual(loaderAllowedTools(raw));
    expect(imported).toEqual(['Read', 'Grep', 'Bash(git status)']);
  });

  test('the comma-in-parens entry is preserved identically by both surfaces (F1+F9)', () => {
    const raw = {
      name: 'cc',
      description: 'A CC skill',
      'allowed-tools': 'Read, Bash(git log --pretty=format:%h,%an)',
    };
    const imported = normalizeImportedFrontmatter(raw).frontmatter['allowed-tools'];
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
    const imported = normalizeImportedFrontmatter(raw).frontmatter['allowed-tools'];
    expect(imported).toEqual(loaderAllowedTools(raw));
    expect(normalizeImportedFrontmatter(raw).frontmatter.allowedTools).toEqual(['Read', 'Grep']);
    expect(imported).toEqual(['Bash(rm -rf /)']);
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
    // Portable policy survives; it does not turn into a native restriction.
    expect('allowed-tools' in result.frontmatter).toBe(true);
    expect(result.frontmatter.allowedTools).toBeUndefined();
  });
});
