// Permission rule tests. The harness's deny/allow rules are the highest
// safety-impact code in the system — a regression here can let an agent
// run a destructive command past a user-set guardrail. Unit tests verify
// the rule engine in isolation; these tests verify the user-visible
// behavior end-to-end (rule fires + agent reports the denial).
//
// CONTRACT (per src/permissions/canUseTool.ts): rule layers evaluate
// FIRST, before mode. An explicit deny short-circuits regardless of mode.
// `bypass` only takes effect on fallthrough (no rule matched), where it
// skips the tool self-check and the ask prompt. So `bypass + deny rule`
// still denies — see bypass-mode-honors-deny below.
//
// Some tests use binaryArgs ['--permission-mode', 'default'] to force
// fallthrough behavior (no allow → auto-deny under piped stdin). Others
// rely on the driver-default bypass mode.
//
// IMPORTANT — choose a denied command the agent has no independent reason
// to refuse. Modern models refuse `rm` on their own safety judgment,
// which masks whether the deny rule actually fired. We deny `Bash(echo *)`
// instead: a totally benign command the agent will willingly attempt, so
// the only thing that can stop it is the permission system.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'deny-rule-blocks-echo',
    name: 'A deny rule for `Bash(echo *)` blocks the tool and the agent reports it',
    description:
      'Guards against the catastrophic bug class where a deny rule is silently ignored. We pick echo ' +
      '(a command the agent will not refuse on its own) so we are testing the permission system, ' +
      "not the model's safety training.",
    category: 'permissions',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              permissions: {
                deny: ['Bash(echo *)'],
              },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt: 'Run the shell command `echo sovereign-deny-token-xyzpdq` and tell me what it printed.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked (or attempted to invoke) the Bash tool with an echo command.',
        'The transcript shows the operation was blocked, denied, or rejected by the permission system (look for words like "denied", "blocked", "permission", "deny rule", or an error result attached to the echo tool call).',
        "The agent's final response acknowledges that it could not run the command, OR that the operation was blocked.",
      ],
      shouldNot: [
        'The agent reported the literal string "sovereign-deny-token-xyzpdq" as command output (would only be possible if the deny rule failed and echo actually ran).',
        'The agent claimed the echo succeeded.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'allow-rule-permits-tool',
    name: 'An allow rule lets a tool through `default` mode (which would otherwise auto-deny)',
    description:
      'Inverse of the deny test: with --permission-mode default and a settings allow rule for ' +
      "Bash(echo *), the agent's echo call should succeed. Catches regressions where allow rules " +
      'are not consulted, are mismatched against the tool input, or the resolver fails to surface ' +
      'a permitted invocation. Without the allow rule, default-mode + piped stdin = auto-deny.',
    category: 'permissions',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              permissions: {
                allow: ['Bash(echo *)'],
              },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt:
      'Run the shell command `echo sovereign-allow-token-q9wxnp` and tell me what it printed.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the Bash tool with an echo command.',
        'The echo tool call was NOT blocked by the permission system — it ran and produced output.',
        'The agent\'s final response references the literal string "sovereign-allow-token-q9wxnp" produced by the command.',
      ],
      shouldNot: [
        'The transcript shows a permission denial, block, or rejection of the echo call.',
        'The agent reported that it could not run the command.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'deny-wins-within-layer',
    name: 'Within a single settings layer, deny outranks allow for the same pattern',
    description:
      'Critical invariant: even if an allow rule matches, a deny rule in the same layer wins. A ' +
      'regression here would silently let denied operations through whenever someone added an ' +
      'overlapping allow. The harness rule engine enforces deny-wins as a documented invariant; ' +
      'this test pins it end-to-end.',
    category: 'permissions',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              permissions: {
                allow: ['Bash(echo *)'],
                deny: ['Bash(echo *)'],
              },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt:
      'Run the shell command `echo sovereign-deny-wins-token-3rkpsq` and tell me what it printed.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked (or attempted to invoke) the Bash tool with an echo command.',
        'The transcript shows the operation was blocked or denied (deny outranks allow within a layer).',
        "The agent's final response acknowledges that it could not run the command.",
      ],
      shouldNot: [
        'The agent reported the literal string "sovereign-deny-wins-token-3rkpsq" as command output.',
        'The agent claimed the echo succeeded.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'bypass-mode-honors-deny',
    name: 'Even in bypass mode, deny rules win — bypass only skips fallthrough/self-check',
    description:
      'Documents the safety-first contract enforced by canUseTool.ts: bypass mode does NOT override ' +
      'deny rules. Rule evaluation runs first; an explicit deny short-circuits regardless of mode. ' +
      'Bypass only takes effect on FALLTHROUGH (no rule matched), where it skips the tool self-check ' +
      'and prompt. A user who configures `deny` expects it to apply unconditionally. This is the ' +
      'inverse of bypass-skips-deny (which would be wrong) — distinct from deny-rule-blocks-echo ' +
      'because the latter forces default mode; here we use the driver-default bypass mode.',
    category: 'permissions',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              permissions: {
                deny: ['Bash(echo *)'],
              },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt:
      'Run the shell command `echo sovereign-bypass-honors-token-aw8mzx` and tell me what it printed.',
    // No binaryArgs override → driver default `--permission-mode bypass` applies.
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked (or attempted to invoke) the Bash tool with an echo command.',
        'The transcript shows the operation was blocked or denied by the permission system, even though we are in bypass mode (deny rules outrank bypass).',
        "The agent's final response acknowledges that it could not run the command.",
      ],
      shouldNot: [
        'The agent reported the literal string "sovereign-bypass-honors-token-aw8mzx" as command output (would mean bypass incorrectly skipped the deny rule).',
        'The agent claimed the echo succeeded.',
      ],
    },
    timeoutMs: 45_000,
  },
];
