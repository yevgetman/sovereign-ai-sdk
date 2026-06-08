// 2026-05-24 — Semantic test suite for the rebuilt config UX.
//
// These cases run via `bun run test:semantic` against the live `sov`
// binary in headless `sov drive` mode. Each case fires `/config ...`
// slash commands and asserts the user-visible behavior of the new
// catalog-driven picker (replaces the legacy raw-mode picker + JSON
// dump). Guards against:
//   - /config (no args) regressing to a JSON dump (was config2.png)
//   - /config opening with missing groups (was config1.png)
//   - reload-needed badge missing on fields like taskRouting.enabled
//   - live-apply hooks silently dropping the side-effect signal
//   - secret fields leaking raw values into the picker rows
//   - schema validation failures crashing instead of surfacing inline
//
// Plan: docs/plans/2026-05-24-config-ux-rebuild.md (T9)
// Spec: docs/specs/2026-05-24-config-ux-rebuild-design.md
//
// All cases run as `category: 'commands'` because the config
// surface is a slash-command concern (parallel to /model, /resume,
// /export, /theme — each of which has at least one case in the
// commands suite).

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'config-root-menu-not-json-dump',
    name: '/config opens a menu, not a JSON dump',
    description:
      'When the user invokes /config with no args, the response must be an interactive menu — ' +
      'never the raw JSON dump the old surface emitted (config2.png). The judge checks the ' +
      'transcript for the menu chrome (group labels: General, Providers, Task routing, etc.) and ' +
      'rejects a transcript that begins with a JSON brace.',
    category: 'commands',
    prompt: '/config',
    judgeCriteria: {
      mustSatisfy: [
        'the response shows a config picker with multiple groups (e.g. General, Providers, Task routing, Appearance)',
        'the response is presented as a navigable menu, not as raw JSON',
      ],
      shouldNot: [
        'the entire response is a JSON-formatted dump of config values',
        'the response is the legacy "defaultProvider: ..., defaultModel: ..." flat list',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'config-task-routing-submenu-has-reload-badge',
    name: '/config task-routing surfaces ⟳ next session badge',
    description:
      'taskRouting.enabled is reload-needed (the runtime binds the lane registry at boot). When ' +
      'the user drills into the task-routing submenu, the enabled field must show a "next ' +
      'session" / reload-needed badge so the user understands the change won\'t take effect until ' +
      'restart. Guards against silently persisting reload-needed fields without informing the user.',
    category: 'commands',
    prompt: '/config task-routing',
    judgeCriteria: {
      mustSatisfy: [
        'the response shows a submenu for taskRouting fields including enabled',
        'the enabled field is associated with an indicator that says next session, reload, or equivalent ("will take effect after restart" / "⟳" / "applies on next session" / similar wording)',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'config-set-theme-live-applies',
    name: 'config set theme applies immediately',
    description:
      'theme is in the v0 live-apply set. Setting it via /config set must (a) persist to disk and ' +
      '(b) signal that the change took effect in the current session — not "next session". Guards ' +
      'against the live-apply hook silently degrading to persisted-only.',
    category: 'commands',
    prompt: '/config set theme light',
    judgeCriteria: {
      mustSatisfy: [
        'the response confirms the theme was set or saved',
        'the response indicates the change applied to the current session (live / applied / immediately) rather than requiring a restart',
      ],
      shouldNot: ['the response says the theme change requires a restart or new session'],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'config-set-invalid-permission-mode-error',
    name: 'config set rejects invalid permission mode with clear error',
    description:
      'When the user tries to set permissionMode to a value outside the enum (default | ask | ' +
      'bypass), the slash command must return a clean validation error — not crash, not silently ' +
      'persist garbage, not surface a Zod stack trace. Guards against schema-validation regressions.',
    category: 'commands',
    prompt: '/config set permissionMode whatever',
    judgeCriteria: {
      mustSatisfy: [
        'the response surfaces an error indicating the value is invalid or rejected',
        'the error message mentions the field, the rejected value, or the allowed enum values',
      ],
      shouldNot: [
        'the response is a long stack trace',
        'the response says the value was successfully set',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'config-providers-anthropic-apikey-masked',
    name: 'config picker masks API key values',
    description:
      'Secret fields (providers.anthropic.apiKey, providers.openai.apiKey, etc.) must never display ' +
      'their raw value in the picker rows. When the user drills into the anthropic provider ' +
      'submenu, the apiKey row must show bullets, asterisks, "(set)", or similar redacted ' +
      'placeholder — never the actual key contents. Guards against accidental credential leak ' +
      'in the UI.',
    category: 'commands',
    prompt: '/config providers-anthropic',
    setup: {
      userConfig: {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-secret-key-do-not-leak',
            model: 'claude-haiku-4-5-20251001',
          },
        },
      },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the response shows the anthropic provider submenu including the apiKey row',
        'the apiKey value is rendered in a masked or redacted form (bullets, asterisks, "(set)", or similar)',
      ],
      shouldNot: [
        'the raw API key string "sk-ant-secret-key-do-not-leak" appears anywhere in the response',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'config-subscription-executor-submenu-reload-badge',
    name: '/config subscription-executor surfaces ⟳ next session badge',
    description:
      'subscriptionExecutor was added to the catalog (2026-06-08) so the opt-in headless Claude ' +
      'Code executor is editable from the TUI, not just config.json. The scheduler captures the ' +
      'executor config at boot and never refreshes it, so every field is next-session (no live-' +
      'apply hook). Drilling into the submenu must list the subscriptionExecutor fields (enabled, ' +
      'permissionMode, ...) and associate enabled with a reload / next-session indicator.',
    category: 'commands',
    prompt: '/config subscription-executor',
    judgeCriteria: {
      mustSatisfy: [
        'the response shows a submenu for subscriptionExecutor fields including enabled and permissionMode',
        'the enabled field is associated with an indicator that says next session, reload, or equivalent ("will take effect after restart" / "⟳" / "applies on next session" / similar wording)',
      ],
      shouldNot: [
        'the entire response is a raw JSON dump of config values',
        'the response claims the change applies immediately / live to the current session',
      ],
    },
    timeoutMs: 30_000,
  },
];
