// Curated config catalog — the single source of truth for the
// hierarchical `/config` slash command and `sov config` standalone
// surface. See docs/specs/2026-05-24-config-ux-rebuild-design.md.
//
// Adding a setting:
//   1. Extend SettingsSchema in `src/config/schema.ts`.
//   2. Add a ConfigItem under the appropriate group below.
//   3. If the field is live-applyable from a running session, register a
//      hook in `src/config/liveApply.ts` keyed by dotpath. The catalog
//      reads `LIVE_APPLY_HOOKS` and surfaces the `live` badge for any
//      item whose path is in that map.
//
// The catalog covers every field in SettingsSchema; new top-level fields
// surface under `Advanced (unmanaged)` via `listUnmanagedKeys` until they
// are categorized here. That fallback is the safety net — never delete
// it.

import { LIVE_APPLY_HOOKS, type LiveApplyHook } from './liveApply.js';
import type { SettingsInput } from './schema.js';

/**
 * Editor types. Drive the renderer choice in the dispatcher:
 * `boolean` and `enum` open a PickerCard; `string`, `number`, and `secret`
 * open an InputCard.
 */
export type ConfigEditor =
  | { kind: 'boolean' }
  | { kind: 'enum'; choices: readonly string[] }
  | {
      kind: 'string';
      placeholder?: string;
      choices?: readonly string[];
      /** 2026-05-24 patch — settings-aware choices, evaluated at picker-
       *  render time. Used by `defaultModel` to scope choices to the
       *  active `defaultProvider`'s known model list. */
      dynamicChoices?: (settings: import('./schema.js').Settings) => readonly string[];
      /** 2026-05-24 patch — when true, the choices picker includes a
       *  "↪ type custom value…" sentinel. Selecting it reroutes to an
       *  inputCard so the user can type a value outside the known list. */
      allowCustom?: boolean;
    }
  | { kind: 'number'; min?: number; max?: number; placeholder?: string }
  | { kind: 'secret' };

/**
 * A leaf item in a config group. `path` is the dotpath into Settings that
 * the slash dispatcher uses for setAt/getAt/unsetAt. `liveApply` is looked
 * up by `path` in `LIVE_APPLY_HOOKS` automatically — items don't carry
 * their own hook reference, keeping the catalog purely declarative.
 */
export type ConfigItem = {
  path: string;
  label: string;
  description?: string;
  editor: ConfigEditor;
  secret?: boolean;
};

/**
 * A group of items OR a synthetic "drill-in" group that just routes to
 * other groups (used for the Providers root). Drill-in items have empty
 * value columns and dispatch to `/config <targetGroupId>` rather than
 * opening an editor.
 */
export type ConfigGroup = {
  id: string;
  label: string;
  description?: string;
  items: ConfigItem[];
  /** Drill-in subgroup pointers (e.g., providers → anthropic / openai / ...). */
  drillInto?: { label: string; targetGroupId: string }[];
};

// ──────────────────────────────────────────────────────────────────────
// Reusable choice lists
// ──────────────────────────────────────────────────────────────────────

const PROVIDER_CHOICES = ['anthropic', 'openai', 'openrouter', 'ollama', 'sov'] as const;
const PERMISSION_MODE_CHOICES = ['default', 'ask', 'bypass'] as const;
// Reasoning-depth levels for `thinking.effort`. Mirrors REASONING_EFFORTS in
// src/providers/effort.ts — keep in sync. `off` is the default (no extended
// thinking; byte-identical request).
const EFFORT_CHOICES = ['off', 'low', 'medium', 'high', 'max'] as const;
const THEME_CHOICES = ['dark', 'light', 'no-color'] as const;
const ROUTER_LANE_CHOICES = ['local', 'frontier'] as const;
const ROUTER_ESCALATION_CHOICES = ['ask', 'auto', 'never'] as const;
const WEBSEARCH_PROVIDER_CHOICES = ['tavily', 'brave'] as const;
// Subscription-executor enums. Mirror the `subscriptionExecutor` block in
// src/config/schema.ts. `permissionMode` is DELIBERATELY a different set from
// the top-level `PERMISSION_MODE_CHOICES` — it maps to the spawned subprocess's
// posture. `bypass` is the DEFAULT (→ `--dangerously-skip-permissions`) since a
// headless `claude -p` has no interactive approver; `plan`/`acceptEdits`/
// `default` map to `--permission-mode <mode>` as safer opt-in alternatives.
const SUBSCRIPTION_EXECUTOR_ENGINE_CHOICES = ['claude-code'] as const;
const SUBSCRIPTION_EXECUTOR_PERMISSION_MODE_CHOICES = [
  'bypass',
  'plan',
  'acceptEdits',
  'default',
] as const;

// Provider-specific model lists. Mirrors src/commands/pickers.ts. Keep in
// sync — both surfaces should suggest the same set.
const ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
] as const;
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;
const OPENROUTER_MODELS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'] as const;
const OLLAMA_MODELS = ['qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:14b', 'llama3.1:8b'] as const;
// The local Sovereign engine advertises models under their real model id (the
// served-model-name defaults to the model id itself — no alias), so you always
// know exactly what you're running. List the installed/served model(s) here.
// (Future: discover these live from the engine's /v1/models — Bucket B.)
const SOV_MODELS = ['mlx-community/Qwen3-4B-4bit'] as const;

/**
 * Map a provider name to its known model list. Used by `defaultModel`'s
 * dynamicChoices so the picker shows the right models for the active
 * `defaultProvider`. Falls back to Anthropic's list when the provider
 * is unknown or unset, mirroring the legacy raw-mode picker.
 * 2026-05-24 patch.
 */
function modelsForProvider(provider: string | undefined): readonly string[] {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_MODELS;
    case 'openai':
      return OPENAI_MODELS;
    case 'openrouter':
      return OPENROUTER_MODELS;
    case 'ollama':
      return OLLAMA_MODELS;
    case 'sov':
      return SOV_MODELS;
    default:
      return ANTHROPIC_MODELS;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Groups
// ──────────────────────────────────────────────────────────────────────

const GENERAL_GROUP: ConfigGroup = {
  id: 'general',
  label: 'General',
  description: 'Provider defaults, permission mode, turn limit, verbose mode.',
  items: [
    {
      path: 'defaultProvider',
      label: 'defaultProvider',
      description: 'Provider used when no --provider flag is supplied at boot.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'defaultModel',
      label: 'defaultModel',
      description:
        'Model used when no --model flag is supplied. Choices scoped to defaultProvider. Live-applied to the active session.',
      editor: {
        kind: 'string',
        placeholder: 'e.g. claude-sonnet-4-6',
        // 2026-05-24 patch — dynamic choices scoped by defaultProvider.
        // Mirrors the legacy raw-mode picker's modelsForProvider helper.
        dynamicChoices: (settings) => modelsForProvider(settings.defaultProvider),
        allowCustom: true,
      },
    },
    {
      path: 'permissionMode',
      label: 'permissionMode',
      description:
        'default = ask on first use, then remember; ask = always ask; bypass = auto-allow.',
      editor: { kind: 'enum', choices: PERMISSION_MODE_CHOICES },
    },
    {
      path: 'thinking.effort',
      label: 'thinking.effort',
      description:
        'Reasoning-depth default for extended thinking. off = no thinking (default); low/medium/high/max enable it on reasoning-capable models. The /effort command overrides per session.',
      editor: { kind: 'enum', choices: EFFORT_CHOICES },
    },
    {
      path: 'maxTurns',
      label: 'maxTurns',
      description:
        'Runaway-loop circuit breaker (default 100). Effective next session — the running runtime captures the value at boot.',
      editor: { kind: 'number', min: 1, placeholder: '100' },
    },
    {
      path: 'verbose',
      label: 'verbose',
      description: 'Show full tool-result preview blocks instead of the one-line compact summary.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'behavior.maxToolCallsBeforeCheckin',
      label: 'behavior.maxToolCallsBeforeCheckin',
      description:
        'Pause the turn loop after this many tool calls and ask the user before continuing. Default unset (no limit).',
      editor: { kind: 'number', min: 1 },
    },
  ],
};

// ── Providers (drill-in root + per-provider subgroups) ────────────────

const PROVIDERS_ROOT_GROUP: ConfigGroup = {
  id: 'providers',
  label: 'Providers',
  description: 'Per-provider API key, model default, and connection settings.',
  items: [],
  drillInto: [
    { label: 'Anthropic', targetGroupId: 'providers-anthropic' },
    { label: 'OpenAI', targetGroupId: 'providers-openai' },
    { label: 'OpenRouter', targetGroupId: 'providers-openrouter' },
    { label: 'Ollama', targetGroupId: 'providers-ollama' },
  ],
};

const PROVIDERS_ANTHROPIC_GROUP: ConfigGroup = {
  id: 'providers-anthropic',
  label: 'Providers / Anthropic',
  items: [
    {
      path: 'providers.anthropic.apiKey',
      label: 'apiKey',
      description: 'Anthropic API key. Used by the official anthropic provider.',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'providers.anthropic.model',
      label: 'model',
      description: 'Default Anthropic model. Live-applied when Anthropic is the active provider.',
      editor: { kind: 'string', choices: ANTHROPIC_MODELS },
    },
  ],
};

const PROVIDERS_OPENAI_GROUP: ConfigGroup = {
  id: 'providers-openai',
  label: 'Providers / OpenAI',
  items: [
    {
      path: 'providers.openai.apiKey',
      label: 'apiKey',
      description: 'OpenAI API key (sk-...).',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'providers.openai.model',
      label: 'model',
      description: 'Default OpenAI model. Live-applied when OpenAI is the active provider.',
      editor: { kind: 'string', choices: OPENAI_MODELS },
    },
    {
      path: 'providers.openai.baseUrl',
      label: 'baseUrl',
      description: 'Override the API endpoint (e.g., for Azure OpenAI or proxies).',
      editor: { kind: 'string', placeholder: 'https://api.openai.com/v1' },
    },
  ],
};

const PROVIDERS_OPENROUTER_GROUP: ConfigGroup = {
  id: 'providers-openrouter',
  label: 'Providers / OpenRouter',
  items: [
    {
      path: 'providers.openrouter.apiKey',
      label: 'apiKey',
      description: 'OpenRouter API key.',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'providers.openrouter.model',
      label: 'model',
      description: 'Default OpenRouter model. Live-applied when OpenRouter is the active provider.',
      editor: { kind: 'string', choices: OPENROUTER_MODELS },
    },
  ],
};

const PROVIDERS_OLLAMA_GROUP: ConfigGroup = {
  id: 'providers-ollama',
  label: 'Providers / Ollama',
  items: [
    {
      path: 'providers.ollama.model',
      label: 'model',
      description: 'Default local model. Live-applied when Ollama is the active provider.',
      editor: { kind: 'string', choices: OLLAMA_MODELS },
    },
    {
      path: 'providers.ollama.baseUrl',
      label: 'baseUrl',
      description: 'Ollama server endpoint.',
      editor: { kind: 'string', placeholder: 'http://localhost:11434' },
    },
    {
      path: 'providers.ollama.numCtx',
      label: 'numCtx',
      description: 'Explicit num_ctx override (default: model registered context length).',
      editor: { kind: 'number', min: 1, placeholder: '8192' },
    },
  ],
};

// ── Task routing ──────────────────────────────────────────────────────

const TASK_ROUTING_GROUP: ConfigGroup = {
  id: 'task-routing',
  label: 'Task routing',
  description:
    'Multi-provider smart router. Changes apply to the next turn — lane registry + parent prompt rebuild on save.',
  items: [
    {
      path: 'taskRouting.enabled',
      label: 'enabled',
      description: 'Activate delegator-first turn flow. Defaults to false.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'taskRouting.trivialFastPath',
      label: 'trivialFastPath',
      description:
        'Allow parent to bypass the delegator on trivial turns (greetings, one-liner facts, meta-questions). Saves ~2 model calls on conversational turns. Default off — preserves strict always-dispatch contract.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'taskRouting.delegator.model',
      label: 'delegator.model',
      description:
        'Model the delegator uses to decompose user turns into atoms. Default claude-sonnet-4-6.',
      editor: { kind: 'string' },
    },
    {
      path: 'taskRouting.lanes.cheap-task.provider',
      label: 'lanes.cheap-task.provider',
      description: 'Provider override for the cheap-task lane.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'taskRouting.lanes.cheap-task.model',
      label: 'lanes.cheap-task.model',
      description: 'Model override for the cheap-task lane. Choices scoped to the lane provider.',
      editor: {
        kind: 'string',
        dynamicChoices: (settings) =>
          modelsForProvider(settings.taskRouting?.lanes?.['cheap-task']?.provider),
        allowCustom: true,
      },
    },
    {
      path: 'taskRouting.lanes.cheap-task.timeoutMs',
      label: 'lanes.cheap-task.timeoutMs',
      description: 'Per-atom timeout for the cheap-task lane. Default 120000.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'taskRouting.lanes.moderate-task.provider',
      label: 'lanes.moderate-task.provider',
      description: 'Provider override for the moderate-task lane.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'taskRouting.lanes.moderate-task.model',
      label: 'lanes.moderate-task.model',
      description:
        'Model override for the moderate-task lane. Choices scoped to the lane provider.',
      editor: {
        kind: 'string',
        dynamicChoices: (settings) =>
          modelsForProvider(settings.taskRouting?.lanes?.['moderate-task']?.provider),
        allowCustom: true,
      },
    },
    {
      path: 'taskRouting.lanes.moderate-task.timeoutMs',
      label: 'lanes.moderate-task.timeoutMs',
      description: 'Per-atom timeout for the moderate-task lane. Default 120000.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'taskRouting.lanes.frontier-task.provider',
      label: 'lanes.frontier-task.provider',
      description: 'Provider override for the frontier-task lane.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'taskRouting.lanes.frontier-task.model',
      label: 'lanes.frontier-task.model',
      description:
        'Model override for the frontier-task lane. Choices scoped to the lane provider.',
      editor: {
        kind: 'string',
        dynamicChoices: (settings) =>
          modelsForProvider(settings.taskRouting?.lanes?.['frontier-task']?.provider),
        allowCustom: true,
      },
    },
    {
      path: 'taskRouting.lanes.frontier-task.timeoutMs',
      label: 'lanes.frontier-task.timeoutMs',
      description: 'Per-atom timeout for the frontier-task lane. Default 120000.',
      editor: { kind: 'number', min: 1 },
    },
  ],
};

// ── Subscription executor (opt-in, off by default) ───────────────────

const SUBSCRIPTION_EXECUTOR_GROUP: ConfigGroup = {
  id: 'subscription-executor',
  label: 'Subscription executor',
  description:
    'Opt-in headless Claude Code executor — delegate sub-agent work to a `claude -p` subprocess ' +
    'under your own subscription. Personal/attended use only; mutually exclusive with Task routing. ' +
    'Effective next session.',
  items: [
    {
      path: 'subscriptionExecutor.enabled',
      label: 'enabled',
      description:
        'Route `subscription-executor` delegations to a headless `claude -p` subprocess (flat-rate ' +
        'subscription cost instead of per-token API). Off by default. Requires the `claude` CLI ' +
        'installed + logged in. By default the subprocess runs with ' +
        '`--dangerously-skip-permissions` (configurable via permissionMode). Personal/attended use ' +
        'only — deliberately NOT wired to cron / channels / gateway. Mutually exclusive with ' +
        'taskRouting.enabled.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'subscriptionExecutor.engine',
      label: 'engine',
      description: 'Execution engine. Only `claude-code` is supported in this spike.',
      editor: { kind: 'enum', choices: SUBSCRIPTION_EXECUTOR_ENGINE_CHOICES },
    },
    {
      path: 'subscriptionExecutor.binary',
      label: 'binary',
      description:
        'The `claude` executable to spawn. Default `claude`; set an absolute path if it is not on PATH.',
      editor: { kind: 'string', placeholder: 'claude' },
    },
    {
      path: 'subscriptionExecutor.permissionMode',
      label: 'permissionMode',
      description:
        'Permission posture for the spawned `claude -p`. Default `bypass` → ' +
        '`--dangerously-skip-permissions` (a headless subprocess has no interactive approver, so the ' +
        'safe modes stall real work). `plan` | `acceptEdits` | `default` map to ' +
        '`--permission-mode <mode>` for a constrained posture. Bounded to this attended, ' +
        'interactive-only executor — the remote channels keep their own bypass rejection.',
      editor: { kind: 'enum', choices: SUBSCRIPTION_EXECUTOR_PERMISSION_MODE_CHOICES },
    },
    {
      path: 'subscriptionExecutor.timeoutMs',
      label: 'timeoutMs',
      description:
        'Per-delegation wall-clock cap in milliseconds (default 600000). The subprocess is killed and ' +
        'its stdio readers cancelled on timeout or parent-cancel.',
      editor: { kind: 'number', min: 1, placeholder: '600000' },
    },
    {
      path: 'subscriptionExecutor.maxTurns',
      label: 'maxTurns',
      description:
        "Caps the headless session's agentic turns (maps to `claude -p --max-turns N`). Default 30.",
      editor: { kind: 'number', min: 1, placeholder: '30' },
    },
  ],
};

// ── Router (local-first) ──────────────────────────────────────────────

const ROUTER_GROUP: ConfigGroup = {
  id: 'router',
  label: 'Router (local-first)',
  description: 'Local-vs-frontier escalation router. Effective next session.',
  items: [
    {
      path: 'router.defaultLane',
      label: 'defaultLane',
      description: 'Starting lane for every turn.',
      editor: { kind: 'enum', choices: ROUTER_LANE_CHOICES },
    },
    {
      path: 'router.localProvider',
      label: 'localProvider',
      description: 'Provider name for the local lane.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'router.localModel',
      label: 'localModel',
      description: 'Model for the local lane.',
      editor: { kind: 'string' },
    },
    {
      path: 'router.frontierProvider',
      label: 'frontierProvider',
      description: 'Provider name for the frontier (escalation) lane.',
      editor: { kind: 'enum', choices: PROVIDER_CHOICES },
    },
    {
      path: 'router.frontierModel',
      label: 'frontierModel',
      description: 'Model for the frontier lane.',
      editor: { kind: 'string' },
    },
    {
      path: 'router.escalationMode',
      label: 'escalationMode',
      description: 'ask = prompt user; auto = silent; never = stay on local.',
      editor: { kind: 'enum', choices: ROUTER_ESCALATION_CHOICES },
    },
    {
      path: 'router.maxConcurrentLocal',
      label: 'maxConcurrentLocal',
      description: 'Global cap on concurrent local-lane provider calls. 0 = unbounded.',
      editor: { kind: 'number', min: 0 },
    },
    {
      path: 'router.maxConcurrentFrontier',
      label: 'maxConcurrentFrontier',
      description: 'Global cap on concurrent frontier-lane provider calls. 0 = unbounded.',
      editor: { kind: 'number', min: 0 },
    },
  ],
};

// ── Compaction (proactive + microcompaction) ─────────────────────────

const COMPACTION_GROUP: ConfigGroup = {
  id: 'compaction',
  label: 'Compaction',
  description: 'Proactive and per-message compaction. Effective next session.',
  items: [
    {
      path: 'microcompaction.enabled',
      label: 'microcompaction.enabled',
      description: 'Per-message microcompaction (trim large tool results in-place).',
      editor: { kind: 'boolean' },
    },
    {
      path: 'microcompaction.keepRecent',
      label: 'microcompaction.keepRecent',
      description: 'Number of recent messages to leave untrimmed.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'microcompaction.triggerThresholdPct',
      label: 'microcompaction.triggerThresholdPct',
      description:
        'Microcompact a message whose content exceeds this percentage of the context window.',
      editor: { kind: 'number', min: 0, max: 100 },
    },
    {
      path: 'compaction.proactiveThresholdPct',
      label: 'compaction.proactiveThresholdPct',
      description:
        'Whole-session proactive compaction trigger as percent of context window (default 75).',
      editor: { kind: 'number', min: 1, max: 99 },
    },
  ],
};

// ── Web search ───────────────────────────────────────────────────────

const WEB_SEARCH_GROUP: ConfigGroup = {
  id: 'web-search',
  label: 'Web search',
  description: 'WebSearch tool configuration. Live-applied (read-on-demand by the tool).',
  items: [
    {
      path: 'webSearch.provider',
      label: 'provider',
      description: 'Search provider — tavily (default) or brave.',
      editor: { kind: 'enum', choices: WEBSEARCH_PROVIDER_CHOICES },
    },
    {
      path: 'webSearch.apiKey',
      label: 'apiKey',
      description:
        'API key for the configured provider. Falls back to TAVILY_API_KEY / BRAVE_SEARCH_API_KEY env vars when unset.',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'webSearch.maxResults',
      label: 'maxResults',
      description: 'Max results per query (1–20).',
      editor: { kind: 'number', min: 1, max: 20 },
    },
  ],
};

// ── Review (auto-promote memory + skill review cadence) ──────────────

const REVIEW_GROUP: ConfigGroup = {
  id: 'review',
  label: 'Review',
  description: 'Auto-review and instinct-promotion cadence. Effective next session.',
  items: [
    {
      path: 'review.autoPromoteMemory',
      label: 'autoPromoteMemory',
      description: 'Auto-promote memory candidates (skip review queue when true).',
      editor: { kind: 'boolean' },
    },
    {
      path: 'review.autoPromoteSkills',
      label: 'autoPromoteSkills',
      description: 'Auto-promote skill candidates (skip review queue when true).',
      editor: { kind: 'boolean' },
    },
    {
      path: 'review.userTurnsForMemoryReview',
      label: 'userTurnsForMemoryReview',
      description: 'User turns between memory-review dispatches.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'review.toolIterationsForSkillReview',
      label: 'toolIterationsForSkillReview',
      description: 'Tool iterations between skill-review dispatches.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'review.childReviewEveryN',
      label: 'childReviewEveryN',
      description: 'Run review fork every Nth child session terminal.',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'review.minIntervalMs',
      label: 'minIntervalMs',
      description: 'Floor on time between two dispatches of the same review fork (default 30000).',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'review.disabled',
      label: 'disabled',
      description: 'Disable all auto-review dispatches (manual /review still works).',
      editor: { kind: 'boolean' },
    },
  ],
};

// ── Learning (Phase 13.4 continuous-learning) ────────────────────────

const LEARNING_GROUP: ConfigGroup = {
  id: 'learning',
  label: 'Learning',
  description: 'Continuous-learning observer + instinct corpus. Effective next session.',
  items: [
    {
      path: 'learning.disabled',
      label: 'disabled',
      description: 'Disable the observation writer + synthesizer entirely.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'learning.synthesizerEveryN',
      label: 'synthesizerEveryN',
      description: 'Synthesizer runs every Nth user turn (default 20).',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'learning.synthesizerEveryNToolIterations',
      label: 'synthesizerEveryNToolIterations',
      description: 'Synthesizer also runs every Nth tool iteration (default 50).',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'learning.observationBufferSize',
      label: 'observationBufferSize',
      description: 'In-memory observation buffer cap (default 200).',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'learning.pruneBelowConfidence',
      label: 'pruneBelowConfidence',
      description: 'Confidence threshold below which instincts age out (default 0.3).',
      editor: { kind: 'number', min: 0, max: 1 },
    },
    {
      path: 'learning.pruneAgeDays',
      label: 'pruneAgeDays',
      description:
        'Days without reinforcement before sub-threshold instincts are pruned (default 30).',
      editor: { kind: 'number', min: 1 },
    },
    {
      path: 'learning.reinforcementCurveK',
      label: 'reinforcementCurveK',
      description: 'Logarithmic reinforcement coefficient (default 0.04).',
      editor: { kind: 'number', min: 0 },
    },
    {
      path: 'learning.evidenceSaturation',
      label: 'evidenceSaturation',
      description:
        'Evidence scale (τ) for the saturating confidence curve; smaller ramps faster (default 13).',
      editor: { kind: 'number', min: 0 },
    },
    {
      path: 'learning.contradictionDelta',
      label: 'contradictionDelta',
      description: 'Per-unit contradiction drop (default -0.2; must be ≤ 0).',
      editor: { kind: 'number', max: 0 },
    },
    {
      path: 'learning.confidenceCap',
      label: 'confidenceCap',
      description: 'Confidence ceiling (default 0.9).',
      editor: { kind: 'number', min: 0, max: 1 },
    },
    {
      path: 'learning.initialConfidenceBaseline',
      label: 'initialConfidenceBaseline',
      description: 'Starting-floor for newly proposed instincts (default unset).',
      editor: { kind: 'number', min: 0, max: 1 },
    },
    {
      path: 'learning.crossProjectMinConfidence',
      label: 'crossProjectMinConfidence',
      description: 'Cross-project promotion threshold (default 0.7).',
      editor: { kind: 'number', min: 0, max: 1 },
    },
  ],
};

// ── Debug ────────────────────────────────────────────────────────────

const DEBUG_GROUP: ConfigGroup = {
  id: 'debug',
  label: 'Debug',
  description: 'Developer-facing flags for harness building and debugging. Effective next session.',
  items: [
    {
      path: 'debugMode.enabled',
      label: 'enabled',
      description: 'Umbrella switch — when true, all child debug capabilities auto-enable.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'debugMode.transcript',
      label: 'transcript',
      description: 'Write a redacted JSONL transcript per session.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'debugMode.transcriptDir',
      label: 'transcriptDir',
      description: 'Directory for auto-generated transcripts (default <harnessHome>/debug).',
      editor: { kind: 'string', placeholder: '~/.harness/debug' },
    },
  ],
};

// ── OpenAI server ────────────────────────────────────────────────────

const OPENAI_SERVER_GROUP: ConfigGroup = {
  id: 'openai-server',
  label: 'OpenAI server',
  description: 'OpenAI-compatible HTTP API server (sov serve). Effective next session.',
  items: [
    {
      path: 'openaiServer.apiKey',
      label: 'apiKey',
      description: 'Bearer token clients must send. Required to boot sov serve.',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'openaiServer.port',
      label: 'port',
      description: 'Bind port for sov serve (default 8765).',
      editor: { kind: 'number', min: 1, max: 65535 },
    },
    {
      path: 'openaiServer.host',
      label: 'host',
      description: 'Bind host for sov serve (default 127.0.0.1).',
      editor: { kind: 'string', placeholder: '127.0.0.1' },
    },
  ],
};

// ── Gateway ──────────────────────────────────────────────────────────

const GATEWAY_GROUP: ConfigGroup = {
  id: 'gateway',
  label: 'Gateway',
  description: 'Long-lived native HTTP+SSE gateway (sov gateway). Effective next session.',
  items: [
    {
      path: 'gateway.token',
      label: 'token',
      description: 'Bearer token clients must send. Required when exposed off-loopback.',
      editor: { kind: 'secret' },
      secret: true,
    },
    {
      path: 'gateway.port',
      label: 'port',
      description: 'Bind port for sov gateway (default 8766).',
      editor: { kind: 'number', min: 1, max: 65535 },
    },
    {
      path: 'gateway.host',
      label: 'host',
      description: 'Bind host for sov gateway (default 127.0.0.1 loopback).',
      editor: { kind: 'string', placeholder: '127.0.0.1' },
    },
  ],
};

// ── Appearance ───────────────────────────────────────────────────────

const TOOL_OUTPUT_MODE_CHOICES = ['compact', 'detailed'] as const;

const APPEARANCE_GROUP: ConfigGroup = {
  id: 'appearance',
  label: 'Appearance',
  description: 'Color theme + REPL render polish (footer, context meter, diff, tool output).',
  items: [
    {
      path: 'theme',
      label: 'theme',
      description:
        'Active color theme. Live-applied — change takes effect immediately. NO_COLOR env var overrides.',
      editor: { kind: 'string', choices: THEME_CHOICES },
    },
    {
      path: 'ui.theme',
      label: 'ui.theme',
      description:
        'Legacy UI theme key (M9.5). Same effect as `theme`; the top-level key is canonical.',
      editor: { kind: 'enum', choices: THEME_CHOICES },
    },
    {
      path: 'ui.footer.enabled',
      label: 'ui.footer.enabled',
      description:
        'Pre-prompt status line (provider/model · ctx % · cost · perms · tools). Default true.',
      editor: { kind: 'boolean' },
    },
    {
      path: 'ui.contextMeter.warnAtPercent',
      label: 'ui.contextMeter.warnAtPercent',
      description: 'Footer turns yellow at this context-utilization percentage (0–100).',
      editor: { kind: 'number', min: 0, max: 100 },
    },
    {
      path: 'ui.contextMeter.dangerAtPercent',
      label: 'ui.contextMeter.dangerAtPercent',
      description: 'Footer turns red at this context-utilization percentage (0–100).',
      editor: { kind: 'number', min: 0, max: 100 },
    },
    {
      path: 'ui.diffRender.enabled',
      label: 'ui.diffRender.enabled',
      description:
        'Inline diff renderer for FileEdit / FileWrite results. Default true (always show diffs).',
      editor: { kind: 'boolean' },
    },
    {
      path: 'ui.toolOutput.mode',
      label: 'ui.toolOutput.mode',
      description:
        'compact (default) = one-line per tool_result Claude-mobile-style; detailed = bordered ToolCard with capped output.',
      editor: { kind: 'enum', choices: TOOL_OUTPUT_MODE_CHOICES },
    },
    {
      path: 'ui.toolOutput.inlineLines',
      label: 'ui.toolOutput.inlineLines',
      description:
        'Cap on tool-result output lines in detailed mode (0–200). 0 collapses to header-only.',
      editor: { kind: 'number', min: 0, max: 200 },
    },
  ],
};

/**
 * Ordered catalog. Group ordering drives the root menu's row order. The
 * 4 per-provider subgroups (`providers-anthropic`, etc.) live in the
 * catalog so `findGroup` resolves them, but they're not rendered in the
 * root menu — the Providers root drills into them.
 */
export const CONFIG_CATALOG: readonly ConfigGroup[] = Object.freeze([
  GENERAL_GROUP,
  PROVIDERS_ROOT_GROUP,
  PROVIDERS_ANTHROPIC_GROUP,
  PROVIDERS_OPENAI_GROUP,
  PROVIDERS_OPENROUTER_GROUP,
  PROVIDERS_OLLAMA_GROUP,
  TASK_ROUTING_GROUP,
  SUBSCRIPTION_EXECUTOR_GROUP,
  ROUTER_GROUP,
  COMPACTION_GROUP,
  WEB_SEARCH_GROUP,
  REVIEW_GROUP,
  LEARNING_GROUP,
  DEBUG_GROUP,
  OPENAI_SERVER_GROUP,
  GATEWAY_GROUP,
  APPEARANCE_GROUP,
]);

/**
 * Group IDs that should appear in the root menu picker. Excludes the
 * per-provider subgroups (reached via the Providers drill-in instead).
 */
const ROOT_MENU_GROUP_IDS = Object.freeze([
  'general',
  'providers',
  'task-routing',
  'subscription-executor',
  'router',
  'compaction',
  'web-search',
  'review',
  'learning',
  'debug',
  'openai-server',
  'appearance',
]);

/**
 * Catalog groups visible in the root menu. Order matches
 * `ROOT_MENU_GROUP_IDS`. The per-provider subgroups are reachable only
 * through the Providers drill-in.
 */
export function listRootMenuGroups(): ConfigGroup[] {
  const out: ConfigGroup[] = [];
  for (const id of ROOT_MENU_GROUP_IDS) {
    const group = findGroup(id);
    if (group !== undefined) out.push(group);
  }
  return out;
}

/** Find a group by ID. O(catalog) — fine for the catalog size (≈15). */
export function findGroup(id: string): ConfigGroup | undefined {
  return CONFIG_CATALOG.find((g) => g.id === id);
}

/**
 * Find an item by dotpath. Walks every group's items array. O(total
 * items). Per-provider subgroups are searched too so paths like
 * `providers.anthropic.model` resolve correctly.
 */
export function findItem(path: string): ConfigItem | undefined {
  for (const group of CONFIG_CATALOG) {
    for (const item of group.items) {
      if (item.path === path) return item;
    }
  }
  return undefined;
}

/**
 * Find the group that owns a given item path. Returns the first group
 * whose items array contains an item with the matching path.
 */
export function findGroupForItem(path: string): ConfigGroup | undefined {
  for (const group of CONFIG_CATALOG) {
    for (const item of group.items) {
      if (item.path === path) return group;
    }
  }
  return undefined;
}

/**
 * Returns the live-apply hook registered for a path, or undefined. The
 * catalog itself is purely declarative — the hook lookup goes through
 * `LIVE_APPLY_HOOKS`.
 */
export function getLiveApplyHook(path: string): LiveApplyHook | undefined {
  return LIVE_APPLY_HOOKS[path];
}

/**
 * Walk the persisted Settings object and return the set of top-level
 * keys that don't appear in any catalog item path. Used to surface an
 * "Advanced (unmanaged)" group when the catalog falls behind the schema
 * — we never want to hide a user's data.
 *
 * The check is intentionally shallow: a top-level key counts as managed
 * if any catalog item path starts with `<key>.` or equals `<key>`.
 *
 * Note: SettingsSchema is strict, so `readConfig()` already rejects
 * top-level keys unknown to the schema. The unmanaged set surfaces
 * fields that ARE in the schema but NOT yet in the catalog — a
 * forward-compatibility guard. A test may also call this with a raw
 * dict to verify the function's shape independent of schema parsing.
 */
export function listUnmanagedKeys(settings: SettingsInput): string[] {
  const topLevelKeys = Object.keys(settings as Record<string, unknown>);
  const managedTopLevel = new Set<string>();
  for (const group of CONFIG_CATALOG) {
    for (const item of group.items) {
      const first = item.path.split('.', 1)[0];
      if (first !== undefined) managedTopLevel.add(first);
    }
  }
  return topLevelKeys.filter((k) => !managedTopLevel.has(k));
}
