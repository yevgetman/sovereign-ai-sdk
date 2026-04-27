import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { matchesPathPermissionPattern } from '../../src/tools/permissionMatchers.js';

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
});
