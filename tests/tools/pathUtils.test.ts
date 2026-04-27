import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { expandHomePath, resolveToolPath } from '../../src/tools/pathUtils.js';

describe('tool path utilities', () => {
  test('expandHomePath expands only leading home shorthands', () => {
    expect(expandHomePath('~', '/home/tester')).toBe('/home/tester');
    expect(expandHomePath('~/project/file.txt', '/home/tester')).toBe(
      join('/home/tester', 'project', 'file.txt'),
    );
    expect(expandHomePath('literal~/file.txt', '/home/tester')).toBe('literal~/file.txt');
    expect(expandHomePath('~other/file.txt', '/home/tester')).toBe('~other/file.txt');
  });

  test('resolveToolPath keeps absolute paths and resolves relative paths against cwd', () => {
    expect(resolveToolPath('/tmp/file.txt', '/work')).toBe('/tmp/file.txt');
    expect(resolveToolPath('src/app.ts', '/work')).toBe('/work/src/app.ts');
  });
});
