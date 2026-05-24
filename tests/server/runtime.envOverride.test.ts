import { describe, expect, test } from 'bun:test';
import { resolveTaskRoutingEnabled } from '../../src/server/runtime.js';

describe('resolveTaskRoutingEnabled', () => {
  test('env "1" enables regardless of settings false', () => {
    expect(resolveTaskRoutingEnabled('1', false)).toBe(true);
    expect(resolveTaskRoutingEnabled('1', undefined)).toBe(true);
  });

  test('env "0" disables regardless of settings true', () => {
    expect(resolveTaskRoutingEnabled('0', true)).toBe(false);
    expect(resolveTaskRoutingEnabled('0', undefined)).toBe(false);
  });

  test('unset env falls through to settings', () => {
    expect(resolveTaskRoutingEnabled(undefined, true)).toBe(true);
    expect(resolveTaskRoutingEnabled(undefined, false)).toBe(false);
    expect(resolveTaskRoutingEnabled(undefined, undefined)).toBe(false);
  });

  test('empty string env falls through to settings', () => {
    expect(resolveTaskRoutingEnabled('', true)).toBe(true);
    expect(resolveTaskRoutingEnabled('', false)).toBe(false);
  });

  test('non-canonical env values fall through to settings', () => {
    expect(resolveTaskRoutingEnabled('true', false)).toBe(false);
    expect(resolveTaskRoutingEnabled('false', true)).toBe(true);
    expect(resolveTaskRoutingEnabled('yes', false)).toBe(false);
    expect(resolveTaskRoutingEnabled('2', false)).toBe(false);
  });
});
