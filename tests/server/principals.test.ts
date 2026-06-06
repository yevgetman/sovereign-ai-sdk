// Phase E T1 — principals registry foundation: the pure token→principal
// resolver + the security-load-bearing id validator (id becomes a filesystem
// path segment downstream, so it must reject every traversal / separator /
// empty / control-char case). resolvePrincipal compares constant-time over
// ALL principals (mirrors src/server/auth.ts) so the lookup can't early-exit.

import { describe, expect, test } from 'bun:test';
import { resolvePrincipal, validatePrincipalId } from '../../src/server/principals.js';

describe('validatePrincipalId', () => {
  test('accepts safe ids', () => {
    expect(() => validatePrincipalId('alice')).not.toThrow();
    expect(() => validatePrincipalId('a-b_1')).not.toThrow();
    expect(() => validatePrincipalId('A')).not.toThrow();
    expect(() => validatePrincipalId('Bob-2')).not.toThrow();
  });

  test('rejects empty / traversal / separator / whitespace / control ids', () => {
    for (const bad of ['', '.', '..', 'a/b', '../x', 'a b', 'a\tb', 'a\nb', 'a\0b', 'a.b', './x']) {
      expect(() => validatePrincipalId(bad)).toThrow();
    }
  });
});

describe('resolvePrincipal', () => {
  const principals = [
    { id: 'alice', token: 'tok-a' },
    { id: 'bob', token: 'tok-b', name: 'Bob' },
  ];

  test('resolves a matching token to its principal (with name)', () => {
    expect(resolvePrincipal('tok-b', principals)).toEqual({ id: 'bob', name: 'Bob' });
  });

  test('resolves a principal without a name (no name field on the result)', () => {
    expect(resolvePrincipal('tok-a', principals)).toEqual({ id: 'alice' });
  });

  test('returns null for an unknown token', () => {
    expect(resolvePrincipal('nope', principals)).toBeNull();
  });

  test('resolves a LAST-position principal (does not early-exit before checking all)', () => {
    const many = [
      { id: 'one', token: 'tok-1' },
      { id: 'two', token: 'tok-2' },
      { id: 'three', token: 'tok-3', name: 'Three' },
    ];
    expect(resolvePrincipal('tok-3', many)).toEqual({ id: 'three', name: 'Three' });
  });

  test('empty principals → null', () => {
    expect(resolvePrincipal('anything', [])).toBeNull();
  });
});
