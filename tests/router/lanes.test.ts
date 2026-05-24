import { describe, expect, test } from 'bun:test';
import type { TaskRoutingConfig } from '../../src/config/schema.js';
import { LANE_DEFAULTS, resolveLane } from '../../src/router/lanes.js';

describe('resolveLane', () => {
  test('returns default for cheap-task when no override', () => {
    const lane = resolveLane('cheap-task', undefined);
    expect(lane).toEqual(LANE_DEFAULTS['cheap-task']);
  });

  test('returns default for moderate-task and frontier-task', () => {
    expect(resolveLane('moderate-task', undefined)?.model).toBe('claude-sonnet-4-6');
    expect(resolveLane('frontier-task', undefined)?.model).toBe('claude-opus-4-7');
  });

  test('merges per-lane override with defaults', () => {
    const cfg: TaskRoutingConfig = {
      enabled: true,
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: { 'cheap-task': { provider: 'ollama', model: 'qwen2.5:7b' } },
    };
    const lane = resolveLane('cheap-task', cfg);
    expect(lane?.provider).toBe('ollama');
    expect(lane?.model).toBe('qwen2.5:7b');
    expect(lane?.timeoutMs).toBe(120_000); // inherited default
  });

  test('resolves delegator role to taskRouting.delegator.model', () => {
    const cfg: TaskRoutingConfig = {
      enabled: true,
      delegator: { model: 'claude-opus-4-7' },
      lanes: {},
    };
    const lane = resolveLane('delegator', cfg);
    expect(lane?.provider).toBe('anthropic');
    expect(lane?.model).toBe('claude-opus-4-7');
  });

  test('delegator default when no config provided', () => {
    const lane = resolveLane('delegator', undefined);
    expect(lane?.provider).toBe('anthropic');
    expect(lane?.model).toBe('claude-sonnet-4-6');
  });

  test('unknown lane returns undefined', () => {
    expect(resolveLane('explore', undefined)).toBeUndefined();
    expect(resolveLane('plan', undefined)).toBeUndefined();
    expect(resolveLane('', undefined)).toBeUndefined();
  });
});
