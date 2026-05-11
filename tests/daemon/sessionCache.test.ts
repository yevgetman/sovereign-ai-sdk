import { describe, expect, test } from 'bun:test';
import { SessionCache } from '../../src/daemon/sessionCache.js';

describe('SessionCache', () => {
  test('get returns undefined for missing key', () => {
    const cache = new SessionCache(8);
    expect(cache.get('missing')).toBeUndefined();
  });

  test('set and get round-trip', () => {
    const cache = new SessionCache(8);
    cache.set('k1', 'sess-abc');
    const entry = cache.get('k1');
    expect(entry?.sessionId).toBe('sess-abc');
    expect(entry?.lastActive).toBeInstanceOf(Date);
  });

  test('evicts oldest entry when maxSize reached', () => {
    const cache = new SessionCache(2);
    cache.set('k1', 's1');
    cache.set('k2', 's2');
    cache.set('k3', 's3'); // evicts k1 (oldest)
    expect(cache.has('k1')).toBe(false);
    expect(cache.has('k2')).toBe(true);
    expect(cache.has('k3')).toBe(true);
    expect(cache.size).toBe(2);
  });

  test('get refreshes LRU order — accessed entry survives next eviction', () => {
    const cache = new SessionCache(2);
    cache.set('k1', 's1');
    cache.set('k2', 's2');
    cache.get('k1'); // refresh k1 → k2 becomes oldest
    cache.set('k3', 's3'); // evicts k2
    expect(cache.has('k1')).toBe(true);
    expect(cache.has('k2')).toBe(false);
    expect(cache.has('k3')).toBe(true);
  });

  test('delete removes entry and returns true; missing key returns false', () => {
    const cache = new SessionCache(8);
    cache.set('k1', 's1');
    expect(cache.delete('k1')).toBe(true);
    expect(cache.has('k1')).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.delete('nonexistent')).toBe(false);
  });
});
