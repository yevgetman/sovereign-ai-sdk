import { describe, expect, test } from 'bun:test';
import { DECORUM_RETIRED, createDecorumAdapter } from '../../src/conduct/decorumAdapter.js';

describe('decorum adapter', () => {
  test('refuses to build a provider', () => {
    expect(() => createDecorumAdapter()).toThrow(DECORUM_RETIRED);
  });
});
