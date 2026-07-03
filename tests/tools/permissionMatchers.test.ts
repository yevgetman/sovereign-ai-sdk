import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { matchesPathPermissionPattern } from '@yevgetman/sov-sdk/tools/permissionMatchers';

describe('matchesPathPermissionPattern', () => {
  test('expands leading home shorthands before matching paths and patterns', () => {
    const homeFile = join(homedir(), 'project', 'out.md');
    expect(matchesPathPermissionPattern('~/project/out.md', `${homedir()}/project/*.md`)).toBe(
      true,
    );
    expect(matchesPathPermissionPattern(homeFile, '~/project/*.md')).toBe(true);
  });

  test('keeps non-leading tilde characters literal', () => {
    expect(matchesPathPermissionPattern('literal~/out.md', 'literal~/out.md')).toBe(true);
    expect(matchesPathPermissionPattern('literal~/out.md', `${homedir()}/*`)).toBe(false);
  });

  // Polish-pass 2026-07-02 (MEDIUM) — on a case-insensitive filesystem a path
  // and its case variants are the SAME file, so a deny rule must not be
  // bypassable by re-casing the request. The flag is exercised explicitly so the
  // assertion is platform-independent.
  describe('case sensitivity', () => {
    test('case-insensitive matching (macOS/Windows FS) catches a re-cased path', () => {
      // A `deny Read(~/.ssh/id_rsa)` must still match `~/.ssh/ID_RSA`.
      expect(
        matchesPathPermissionPattern('~/.ssh/ID_RSA', '~/.ssh/id_rsa', { caseInsensitive: true }),
      ).toBe(true);
      expect(
        matchesPathPermissionPattern('/etc/Secrets/API_KEY', '/etc/secrets/*', {
          caseInsensitive: true,
        }),
      ).toBe(true);
    });

    test('case-sensitive matching (Linux FS) treats differently-cased paths as distinct', () => {
      expect(
        matchesPathPermissionPattern('~/.ssh/ID_RSA', '~/.ssh/id_rsa', { caseInsensitive: false }),
      ).toBe(false);
      // Same-case still matches under case-sensitive.
      expect(
        matchesPathPermissionPattern('~/.ssh/id_rsa', '~/.ssh/id_rsa', { caseInsensitive: false }),
      ).toBe(true);
    });
  });
});
