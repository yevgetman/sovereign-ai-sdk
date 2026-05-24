// Phase 2.5 — task-routing presets.
//
// A preset is a snapshot of taskRouting.delegator.model +
// taskRouting.lanes.{cheap-task,moderate-task,frontier-task}.{provider,
// model} that the user can apply with one slash invocation instead of
// hand-tuning every lane.
//
// Two flavors:
//
//   BUILTIN_PRESETS — shipped in code, sensible defaults for common
//     setups. Users select one of these to get going without
//     understanding the cost-lane model.
//
//   Saved presets — stored under `taskRouting.savedPresets` in
//     ~/.harness/config.json. The user creates them via
//     `/config save-preset <name>` after they've tuned the lanes to
//     their liking; recall them later via `/config apply-preset <name>`.
//
// Apply semantics: SNAPSHOT, not REFERENCE. Applying writes the
// preset's values into config; the preset name is forgotten. This
// keeps `config.json` transparent (what you see is what's active) and
// plays well with the per-field catalog editor (user can drill into
// any lane after applying to tweak).
//
// 2026-05-24 patch (Phase 2.5).

import type { Settings, TaskRoutingConfig } from './schema.js';

/**
 * The lane-level shape carried by a preset. Mirrors the relevant
 * subset of TaskRoutingConfig — `enabled` and `trivialFastPath` are
 * NOT preset-controlled (they're user preferences, not part of the
 * cost/quality tier choice).
 */
export type PresetShape = {
  delegator: { model: string };
  lanes: {
    'cheap-task': { provider: string; model: string };
    'moderate-task': { provider: string; model: string };
    'frontier-task': { provider: string; model: string };
  };
};

/** Built-in preset entry. `id` is the kebab-case selector; `label` is
 *  what the picker shows; `description` is the one-line hint. */
export type BuiltinPreset = {
  id: string;
  label: string;
  description: string;
  shape: PresetShape;
};

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: 'frugal-anthropic',
    label: 'Frugal — Anthropic',
    description: 'Haiku for cheap+moderate, Sonnet only for hard reasoning. Lowest spend.',
    shape: {
      delegator: { model: 'claude-haiku-4-5-20251001' },
      lanes: {
        'cheap-task': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        'moderate-task': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        'frontier-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
    },
  },
  {
    id: 'full-anthropic',
    label: 'Full Anthropic',
    description: 'Haiku/Sonnet/Opus tiered — the Phase 1 defaults. Balanced cost and quality.',
    shape: {
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: {
        'cheap-task': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        'moderate-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        'frontier-task': { provider: 'anthropic', model: 'claude-opus-4-7' },
      },
    },
  },
  {
    id: 'local-plus-anthropic',
    label: 'Local + Anthropic',
    description: 'Local Ollama for cheap atoms; Sonnet/Opus on Anthropic for moderate+frontier.',
    shape: {
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: {
        'cheap-task': { provider: 'ollama', model: 'qwen2.5:7b' },
        'moderate-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        'frontier-task': { provider: 'anthropic', model: 'claude-opus-4-7' },
      },
    },
  },
] as const;

/** Find a built-in preset by id. */
export function findBuiltinPreset(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

/**
 * Apply a preset shape onto a Settings object, returning the modified
 * settings WITHOUT mutating the input. Preserves all non-preset-
 * controlled fields (`enabled`, `trivialFastPath`, `lanes.<x>.timeoutMs`,
 * `lanes.<x>.maxTokens`, etc.) — preset only sets provider+model per
 * lane + the delegator.model.
 *
 * The caller writes the result back to disk via writeConfig().
 */
export function applyPresetToSettings(settings: Settings, shape: PresetShape): Settings {
  // The legacy null prototype loses the spread; defensive object-build.
  const prevTaskRouting: TaskRoutingConfig | undefined = settings.taskRouting;
  const prevLanes = prevTaskRouting?.lanes ?? {};

  const merged: TaskRoutingConfig = {
    enabled: prevTaskRouting?.enabled ?? false,
    trivialFastPath: prevTaskRouting?.trivialFastPath ?? false,
    delegator: { model: shape.delegator.model },
    lanes: {
      'cheap-task': {
        ...(prevLanes['cheap-task'] ?? {}),
        provider: shape.lanes['cheap-task'].provider,
        model: shape.lanes['cheap-task'].model,
      },
      'moderate-task': {
        ...(prevLanes['moderate-task'] ?? {}),
        provider: shape.lanes['moderate-task'].provider,
        model: shape.lanes['moderate-task'].model,
      },
      'frontier-task': {
        ...(prevLanes['frontier-task'] ?? {}),
        provider: shape.lanes['frontier-task'].provider,
        model: shape.lanes['frontier-task'].model,
      },
    },
  };

  return { ...settings, taskRouting: merged };
}

/**
 * Snapshot the current lane configuration as a PresetShape. Reads from
 * settings.taskRouting; falls back to LANE_DEFAULTS-style anthropic
 * defaults for any unconfigured lane. Used by `/config save-preset`.
 *
 * Returns null when the user hasn't configured any lane provider/model
 * yet AND the current settings carry no taskRouting block at all —
 * saving the all-defaults shape is fine but the caller may prefer to
 * surface a "nothing to snapshot" hint.
 */
export function snapshotCurrentAsPreset(settings: Settings): PresetShape {
  const tr = settings.taskRouting;
  const lanes = tr?.lanes ?? {};
  const cheap = lanes['cheap-task'] ?? {};
  const moderate = lanes['moderate-task'] ?? {};
  const frontier = lanes['frontier-task'] ?? {};
  return {
    delegator: { model: tr?.delegator?.model ?? 'claude-sonnet-4-6' },
    lanes: {
      'cheap-task': {
        provider: cheap.provider ?? 'anthropic',
        model: cheap.model ?? 'claude-haiku-4-5-20251001',
      },
      'moderate-task': {
        provider: moderate.provider ?? 'anthropic',
        model: moderate.model ?? 'claude-sonnet-4-6',
      },
      'frontier-task': {
        provider: frontier.provider ?? 'anthropic',
        model: frontier.model ?? 'claude-opus-4-7',
      },
    },
  };
}

/**
 * Read the saved-presets map from settings, returning an empty object
 * when the field is absent. Insulates callers from the optional nature
 * of the schema field.
 */
export function readSavedPresets(settings: Settings): Record<string, PresetShape> {
  return (settings.taskRouting?.savedPresets ?? {}) as Record<string, PresetShape>;
}

/**
 * Validate a preset name. Kebab-case-ish: lowercase letters, digits,
 * hyphens, and underscores. Must not collide with a built-in id (the
 * apply path would route to the built-in first; collision would be
 * confusing).
 *
 * Returns null on success, an error message string otherwise.
 */
export function validatePresetName(name: string): string | null {
  if (name.length === 0) return 'preset name is required';
  if (name.length > 64) return 'preset name must be 64 characters or fewer';
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return 'preset name must use only lowercase letters, digits, hyphens, or underscores';
  }
  if (findBuiltinPreset(name) !== undefined) {
    return `'${name}' is a built-in preset id; pick a different name`;
  }
  return null;
}
