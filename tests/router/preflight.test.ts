import { describe, expect, test } from 'bun:test';
import { buildLaneRegistry } from '../../src/router/laneRegistry.js';
import { LanePreflightError, runLanePreflight } from '../../src/router/preflight.js';

describe('runLanePreflight', () => {
  test('resolves cleanly when all lanes preflight pass', async () => {
    const registry = buildLaneRegistry(undefined);
    await runLanePreflight({
      registry,
      harnessHome: '/tmp/test-home',
      resolveProvider: async () =>
        ({
          transport: { name: 'mock' },
          model: 'x',
        }) as never,
      preflight: async () => undefined,
    });
    // No throw = pass.
  });

  test('aggregates failures across all cost lanes', async () => {
    const registry = buildLaneRegistry(undefined);
    let attempt = 0;
    await expect(
      runLanePreflight({
        registry,
        harnessHome: '/tmp/test-home',
        resolveProvider: async (provider) => {
          attempt++;
          throw new Error(`missing creds for ${provider}`);
        },
        preflight: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(LanePreflightError);
    expect(attempt).toBeGreaterThanOrEqual(3);
  });

  test('error message lists each failing lane', async () => {
    const registry = buildLaneRegistry(undefined);
    try {
      await runLanePreflight({
        registry,
        harnessHome: '/tmp/test-home',
        resolveProvider: async () => {
          throw new Error('nope');
        },
        preflight: async () => undefined,
      });
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('cheap-task');
      expect(message).toContain('moderate-task');
      expect(message).toContain('frontier-task');
      expect(message).toContain('preflight failures');
    }
  });

  test('skips delegator lane (verified by parent preflight)', async () => {
    const registry = buildLaneRegistry(undefined);
    const seen: string[] = [];
    await runLanePreflight({
      registry,
      harnessHome: '/tmp/test-home',
      resolveProvider: async (provider, model) => {
        seen.push(`${provider}/${model}`);
        return { transport: { name: provider }, model } as never;
      },
      preflight: async () => undefined,
    });
    // Delegator should not be processed.
    expect(seen.length).toBe(3); // cheap, moderate, frontier — NOT delegator
  });

  test('only fails when preflight throws (not resolveProvider returning)', async () => {
    const registry = buildLaneRegistry(undefined);
    await expect(
      runLanePreflight({
        registry,
        harnessHome: '/tmp/test-home',
        resolveProvider: async () => ({ transport: { name: 'mock' }, model: 'x' }) as never,
        preflight: async () => {
          throw new Error('preflight model check failed');
        },
      }),
    ).rejects.toThrow(/preflight model check failed/);
  });
});
