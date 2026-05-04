import { describe, expect, test } from 'bun:test';
import { ArgvSplitError, argvSplit } from '../../src/hooks/argvSplit.js';

describe('argvSplit', () => {
  test('splits on whitespace', () => {
    expect(argvSplit('a b c')).toEqual(['a', 'b', 'c']);
    expect(argvSplit('  a   b\tc\n')).toEqual(['a', 'b', 'c']);
  });

  test('empty input yields empty argv', () => {
    expect(argvSplit('')).toEqual([]);
    expect(argvSplit('   ')).toEqual([]);
  });

  test('single quotes preserve everything literally', () => {
    expect(argvSplit("a 'b c' d")).toEqual(['a', 'b c', 'd']);
    expect(argvSplit('\'"escaped"\'')).toEqual(['"escaped"']);
    expect(argvSplit("'a\\nb'")).toEqual(['a\\nb']);
  });

  test('double quotes allow \\" and \\\\ escapes', () => {
    expect(argvSplit('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(argvSplit('"\\"q\\""')).toEqual(['"q"']);
    expect(argvSplit('"a\\\\b"')).toEqual(['a\\b']);
    // Unrecognized escapes inside double quotes are passed through.
    expect(argvSplit('"a\\nb"')).toEqual(['a\\nb']);
  });

  test('outside-quote backslash escapes the next char', () => {
    expect(argvSplit('a\\ b')).toEqual(['a b']);
    expect(argvSplit('a\\"b')).toEqual(['a"b']);
  });

  test('leading ~/ expands to HOME', () => {
    expect(argvSplit('~/bin/foo --flag', { home: '/Users/test' })).toEqual([
      '/Users/test/bin/foo',
      '--flag',
    ]);
  });

  test('mid-token ~ and bare ~ are left alone', () => {
    expect(argvSplit('a~/b ~', { home: '/Users/test' })).toEqual(['a~/b', '~']);
  });

  test('quoted ~/ does not expand', () => {
    expect(argvSplit("'~/bin/foo'", { home: '/Users/test' })).toEqual(['~/bin/foo']);
  });

  test('throws on unterminated single quote', () => {
    expect(() => argvSplit("a 'bc")).toThrow(ArgvSplitError);
  });

  test('throws on unterminated double quote', () => {
    expect(() => argvSplit('a "bc')).toThrow(ArgvSplitError);
  });

  test('mixed quotes adjacent to unquoted text concatenate', () => {
    expect(argvSplit('"hello"world')).toEqual(['helloworld']);
    expect(argvSplit("a'b c'd")).toEqual(['ab cd']);
  });
});
