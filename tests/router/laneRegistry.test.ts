import { describe, expect, test } from 'bun:test';
import type { TaskRoutingConfig } from '../../src/config/schema.js';
import { buildLaneRegistry } from '../../src/router/laneRegistry.js';

describe('LaneRegistry', () => {
  test('lookup returns defaults for known lane names', () => {
    const registry = buildLaneRegistry(undefined);
    expect(registry.lookup('cheap-task')?.model).toBe('claude-haiku-4-5-20251001');
    expect(registry.lookup('moderate-task')?.model).toBe('claude-sonnet-4-6');
    expect(registry.lookup('frontier-task')?.model).toBe('claude-opus-4-7');
    expect(registry.lookup('delegator')?.model).toBe('claude-sonnet-4-6');
  });

  test('lookup returns undefined for non-lane role', () => {
    const registry = buildLaneRegistry(undefined);
    expect(registry.lookup('explore')).toBeUndefined();
    expect(registry.lookup('plan')).toBeUndefined();
    expect(registry.lookup('')).toBeUndefined();
  });

  test('lookup honors per-lane override', () => {
    const cfg: TaskRoutingConfig = {
      enabled: true,
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: { 'cheap-task': { provider: 'ollama', model: 'qwen2.5:7b' } },
    };
    const registry = buildLaneRegistry(cfg);
    expect(registry.lookup('cheap-task')?.provider).toBe('ollama');
    expect(registry.lookup('cheap-task')?.model).toBe('qwen2.5:7b');
  });

  test('lookup honors delegator model override', () => {
    const cfg: TaskRoutingConfig = {
      enabled: true,
      delegator: { model: 'claude-opus-4-7' },
      lanes: {},
    };
    const registry = buildLaneRegistry(cfg);
    expect(registry.lookup('delegator')?.model).toBe('claude-opus-4-7');
  });

  test('entries returns all four known lanes with their configs', () => {
    const registry = buildLaneRegistry(undefined);
    const entries = registry.entries();
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['cheap-task', 'delegator', 'frontier-task', 'moderate-task']);
  });
});
