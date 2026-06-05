// Phase A T5 — refuse-to-boot safety guard for `sov gateway`.
//
// The gateway entrypoint calls assertGatewaySafe before binding. The throw
// condition is exactly: non-loopback host AND no/empty token — i.e. it must
// never expose the tool-running agent off-loopback without auth.

import { describe, expect, test } from 'bun:test';
import { assertGatewaySafe, isLoopbackHost } from '../../src/server/gatewaySafety.js';

describe('isLoopbackHost', () => {
  test('loopback hosts', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(h)).toBe(true);
  });
  test('non-loopback hosts', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', 'example.com', '::'])
      expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('assertGatewaySafe', () => {
  test('loopback + no token → OK', () => {
    expect(() => assertGatewaySafe({ host: '127.0.0.1', token: undefined })).not.toThrow();
  });
  test('loopback + token → OK', () => {
    expect(() => assertGatewaySafe({ host: 'localhost', token: 't' })).not.toThrow();
  });
  test('non-loopback + token → OK', () => {
    expect(() => assertGatewaySafe({ host: '0.0.0.0', token: 't' })).not.toThrow();
  });
  test('non-loopback + no token → THROWS', () => {
    expect(() => assertGatewaySafe({ host: '0.0.0.0', token: undefined })).toThrow();
  });
  test('non-loopback + empty token → THROWS', () => {
    expect(() => assertGatewaySafe({ host: '0.0.0.0', token: '' })).toThrow();
  });
});
