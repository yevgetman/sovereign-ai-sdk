// Phase 2.5 — preset module unit tests.

import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PRESETS,
  applyPresetToSettings,
  findBuiltinPreset,
  readSavedPresets,
  snapshotCurrentAsPreset,
  validatePresetName,
} from '../../src/config/presets.js';
import type { Settings } from '../../src/config/schema.js';

describe('BUILTIN_PRESETS', () => {
  test('ships the three documented presets', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(ids).toContain('frugal-anthropic');
    expect(ids).toContain('full-anthropic');
    expect(ids).toContain('local-plus-anthropic');
  });

  test('every preset has all three lanes + a delegator', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.shape.delegator.model).toBeTruthy();
      expect(p.shape.lanes['cheap-task'].provider).toBeTruthy();
      expect(p.shape.lanes['cheap-task'].model).toBeTruthy();
      expect(p.shape.lanes['moderate-task'].provider).toBeTruthy();
      expect(p.shape.lanes['moderate-task'].model).toBeTruthy();
      expect(p.shape.lanes['frontier-task'].provider).toBeTruthy();
      expect(p.shape.lanes['frontier-task'].model).toBeTruthy();
    }
  });

  test('findBuiltinPreset round-trips by id', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(findBuiltinPreset(p.id)).toBe(p);
    }
    expect(findBuiltinPreset('nonexistent')).toBeUndefined();
  });
});

describe('applyPresetToSettings', () => {
  const BASE_SETTINGS: Settings = {} as Settings;
  const FULL_ANTHROPIC = BUILTIN_PRESETS.find((p) => p.id === 'full-anthropic');
  if (!FULL_ANTHROPIC) throw new Error('full-anthropic missing from BUILTIN_PRESETS');

  test('writes delegator.model and all three lane provider/model fields', () => {
    const result = applyPresetToSettings(BASE_SETTINGS, FULL_ANTHROPIC.shape);
    expect(result.taskRouting?.delegator.model).toBe('claude-sonnet-4-6');
    expect(result.taskRouting?.lanes['cheap-task']?.provider).toBe('anthropic');
    expect(result.taskRouting?.lanes['cheap-task']?.model).toBe('claude-haiku-4-5-20251001');
    expect(result.taskRouting?.lanes['frontier-task']?.model).toBe('claude-opus-4-7');
  });

  test('preserves existing taskRouting.enabled flag', () => {
    const enabled: Settings = {
      taskRouting: { enabled: true } as Settings['taskRouting'],
    } as Settings;
    const result = applyPresetToSettings(enabled, FULL_ANTHROPIC.shape);
    expect(result.taskRouting?.enabled).toBe(true);
  });

  test('preserves existing taskRouting.trivialFastPath flag', () => {
    const flagged: Settings = {
      taskRouting: {
        enabled: false,
        trivialFastPath: true,
      } as Settings['taskRouting'],
    } as Settings;
    const result = applyPresetToSettings(flagged, FULL_ANTHROPIC.shape);
    expect(result.taskRouting?.trivialFastPath).toBe(true);
  });

  test('preserves per-lane timeoutMs / maxTokens overrides not in preset', () => {
    const tuned: Settings = {
      taskRouting: {
        enabled: false,
        lanes: {
          'cheap-task': { provider: 'old', model: 'old', timeoutMs: 999 },
        },
      } as Settings['taskRouting'],
    } as Settings;
    const result = applyPresetToSettings(tuned, FULL_ANTHROPIC.shape);
    // Preset overwrites provider+model; timeoutMs survives.
    expect(result.taskRouting?.lanes['cheap-task']?.provider).toBe('anthropic');
    expect(result.taskRouting?.lanes['cheap-task']?.timeoutMs).toBe(999);
  });

  test('does not mutate the input settings object', () => {
    const input: Settings = {} as Settings;
    const before = JSON.stringify(input);
    applyPresetToSettings(input, FULL_ANTHROPIC.shape);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('snapshotCurrentAsPreset', () => {
  test('captures fully-configured taskRouting', () => {
    const settings: Settings = {
      taskRouting: {
        enabled: true,
        delegator: { model: 'claude-opus-4-7' },
        lanes: {
          'cheap-task': { provider: 'ollama', model: 'qwen2.5:14b' },
          'moderate-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          'frontier-task': { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
      } as Settings['taskRouting'],
    } as Settings;
    const snap = snapshotCurrentAsPreset(settings);
    expect(snap.delegator.model).toBe('claude-opus-4-7');
    expect(snap.lanes['cheap-task']).toEqual({ provider: 'ollama', model: 'qwen2.5:14b' });
    expect(snap.lanes['moderate-task'].model).toBe('claude-sonnet-4-6');
  });

  test('falls back to defaults for unconfigured lanes', () => {
    const settings: Settings = {} as Settings;
    const snap = snapshotCurrentAsPreset(settings);
    expect(snap.delegator.model).toBe('claude-sonnet-4-6');
    expect(snap.lanes['cheap-task'].provider).toBe('anthropic');
    expect(snap.lanes['cheap-task'].model).toBe('claude-haiku-4-5-20251001');
    expect(snap.lanes['frontier-task'].model).toBe('claude-opus-4-7');
  });
});

describe('readSavedPresets', () => {
  test('returns empty object when taskRouting.savedPresets is absent', () => {
    const settings: Settings = {} as Settings;
    expect(readSavedPresets(settings)).toEqual({});
  });

  test('returns the savedPresets map verbatim', () => {
    const settings = {
      taskRouting: {
        savedPresets: {
          'my-setup': {
            delegator: { model: 'claude-sonnet-4-6' },
            lanes: {
              'cheap-task': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
              'moderate-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
              'frontier-task': { provider: 'anthropic', model: 'claude-opus-4-7' },
            },
          },
        },
      },
    } as unknown as Settings;
    const saved = readSavedPresets(settings);
    expect(saved['my-setup']).toBeDefined();
    expect(saved['my-setup']?.delegator.model).toBe('claude-sonnet-4-6');
  });
});

describe('validatePresetName', () => {
  test('accepts valid names', () => {
    expect(validatePresetName('my-setup')).toBeNull();
    expect(validatePresetName('test_123')).toBeNull();
    expect(validatePresetName('a')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(validatePresetName('')).not.toBeNull();
  });

  test('rejects uppercase, spaces, special chars', () => {
    expect(validatePresetName('My Setup')).not.toBeNull();
    expect(validatePresetName('UPPER')).not.toBeNull();
    expect(validatePresetName('with.dots')).not.toBeNull();
    expect(validatePresetName('with/slash')).not.toBeNull();
  });

  test('rejects collision with built-in preset id', () => {
    expect(validatePresetName('frugal-anthropic')).not.toBeNull();
    expect(validatePresetName('full-anthropic')).not.toBeNull();
    expect(validatePresetName('local-plus-anthropic')).not.toBeNull();
  });

  test('rejects names longer than 64 chars', () => {
    expect(validatePresetName('a'.repeat(65))).not.toBeNull();
    expect(validatePresetName('a'.repeat(64))).toBeNull();
  });
});
