// Phase A gateway hardening (Fix 2) — validate the resolved gateway port.
//
// `SOV_GATEWAY_PORT` and `config.gateway.port` previously flowed into
// Bun.serve unchecked, so 0 / 70000 / -1 / '8080x' silently bound a
// random/clamped port. `resolveGatewayPort` applies the precedence
// (flag > env > config > default 8766) AND validates the resolved value
// is an integer in [1, 65535], throwing a clear Error otherwise.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATEWAY_PORT, resolveGatewayPort } from '../../src/cli/gatewayCommand.js';

describe('resolveGatewayPort', () => {
  describe('precedence', () => {
    test('flag wins over env, config, and default', () => {
      expect(resolveGatewayPort(3000, '4000', 5000)).toBe(3000);
    });

    test('env wins over config and default when no flag', () => {
      expect(resolveGatewayPort(undefined, '4000', 5000)).toBe(4000);
    });

    test('config wins over default when no flag or env', () => {
      expect(resolveGatewayPort(undefined, undefined, 5000)).toBe(5000);
    });

    test('falls back to the default when nothing is provided', () => {
      expect(resolveGatewayPort(undefined, undefined, undefined)).toBe(DEFAULT_GATEWAY_PORT);
      expect(DEFAULT_GATEWAY_PORT).toBe(8766);
    });

    test('an empty env string is treated as unset (falls through to config)', () => {
      expect(resolveGatewayPort(undefined, '', 5000)).toBe(5000);
    });
  });

  describe('valid values pass', () => {
    test('the lower bound (1)', () => {
      expect(resolveGatewayPort(1, undefined, undefined)).toBe(1);
    });

    test('the upper bound (65535)', () => {
      expect(resolveGatewayPort(65535, undefined, undefined)).toBe(65535);
    });

    test('a typical port from env', () => {
      expect(resolveGatewayPort(undefined, '8766', undefined)).toBe(8766);
    });
  });

  describe('invalid values throw', () => {
    test('0 from a flag', () => {
      expect(() => resolveGatewayPort(0, undefined, undefined)).toThrow();
    });

    test('0 from env', () => {
      expect(() => resolveGatewayPort(undefined, '0', undefined)).toThrow();
    });

    test('0 from config', () => {
      expect(() => resolveGatewayPort(undefined, undefined, 0)).toThrow();
    });

    test('70000 (above the range) from env', () => {
      expect(() => resolveGatewayPort(undefined, '70000', undefined)).toThrow();
    });

    test('70000 from config', () => {
      expect(() => resolveGatewayPort(undefined, undefined, 70000)).toThrow();
    });

    test('-1 (negative) from env', () => {
      expect(() => resolveGatewayPort(undefined, '-1', undefined)).toThrow();
    });

    test("'8080x' (trailing garbage) from env", () => {
      expect(() => resolveGatewayPort(undefined, '8080x', undefined)).toThrow();
    });

    test("'abc' (non-numeric) from env", () => {
      expect(() => resolveGatewayPort(undefined, 'abc', undefined)).toThrow();
    });

    test('a non-integer config value', () => {
      expect(() => resolveGatewayPort(undefined, undefined, 8766.5)).toThrow();
    });

    test('the error message names the offending value', () => {
      expect(() => resolveGatewayPort(undefined, '8080x', undefined)).toThrow(/8080x/);
    });
  });
});
