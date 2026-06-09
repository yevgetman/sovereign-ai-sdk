// 2026-06-09 — Semantic test suite for the `/effort` reasoning-depth command.
//
// These cases run via `bun run test:semantic` against the live `sov`
// binary in headless `sov drive` mode. They drive the `/effort` slash
// command and (for the behavioral case) a reasoning-heavy prompt, and let
// the LLM judge decide whether the user-visible behavior is correct.
//
// `/effort off|low|medium|high|max` sets per-session reasoning depth
// (extended-thinking budget). The level forks per provider at the adapter
// boundary (src/providers/effort.ts): Anthropic → thinking.budget_tokens,
// OpenAI reasoning models → reasoning_effort, sov/ollama → enable_thinking.
// `off` (the default) leaves the request byte-identical. A model that can't
// reason gets an unsupported-model notice and no thinking parameter.
//
// Guards against:
//   - `/effort high` not surfacing deeper reasoning / a thinking block on a
//     reasoning-capable model (the core behavioral promise)
//   - `/effort status` regressing (no level / support report)
//   - the unsupported-model notice silently dropping (a thinking param sent
//     to a non-reasoning model would 400)
//
// Spec: docs/specs/2026-06-09-effort-reasoning-depth-design.md
// Usage doc: docs/usage.md § "/effort — reasoning depth"
//
// All cases run as `category: 'commands'` because `/effort` is a slash-command
// concern (parallel to /model, /config, /theme — each of which has at least
// one case in the commands suite). The suite framework auto-discovers any
// `*.cases.ts` file exporting `tests: SemanticTest[]` (no central registry).

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'effort-high-surfaces-deeper-reasoning',
    name: '/effort high then a reasoning-heavy prompt produces visible reasoning',
    description:
      'The core promise of /effort: on a reasoning-capable model (the default claude-haiku-4-5), ' +
      'setting /effort high before a hard multi-step question must dial up extended thinking so the ' +
      'transcript shows deeper reasoning — a thinking block and/or an explicit, correct step-by-step ' +
      'derivation rather than a bare one-line answer. Guards against the level never reaching the ' +
      'provider wire (thinking.budget_tokens) so the request stays byte-identical to off.',
    category: 'commands',
    // Turn 1 sets the level; turn 2 is the reasoning task. The judge sees both.
    prompt: [
      '/effort high',
      'Think this through carefully and show your reasoning. Three people — Ada, Boris, and ' +
        'Chen — each have a different pet (cat, dog, fish) and a different favorite color (red, ' +
        'green, blue). Clues: (1) Ada does not own the cat. (2) The person with the dog likes ' +
        'blue. (3) Boris likes red. (4) Chen does not own the fish. (5) The cat owner likes green. ' +
        'Who owns which pet, and what is each person’s favorite color? State the final assignment.',
    ],
    judgeCriteria: {
      mustSatisfy: [
        'The /effort high command was accepted and the transcript confirms the effort level was set to high for the session.',
        'The agent worked through the puzzle with visible multi-step reasoning (a thinking block and/or an explicit chain of deductions citing the clues), not just a bare final answer.',
        'The agent reached the correct, fully-specified solution: Ada owns the dog and likes blue; Boris owns the fish and likes red; Chen owns the cat and likes green.',
      ],
      shouldNot: [
        'The agent reported that the effort level could not be changed or that /effort is unknown.',
        'The agent gave only a final answer with no reasoning and that answer was wrong or incomplete.',
      ],
    },
    // Multi-turn + a deliberately hard prompt at high reasoning depth — give it room.
    timeoutMs: 180_000,
  },
  {
    id: 'effort-status-reports-level-and-support',
    name: '/effort status reports the current level and reasoning support',
    description:
      'Without an arg-set, /effort status (and its alias /effort current) must report the current ' +
      'reasoning-depth level for the session and whether the active model supports reasoning — a ' +
      'non-interactive read with no mutation. The default model (claude-haiku-4-5) supports ' +
      'reasoning, so the report must say so. Guards against the status/current read path regressing.',
    category: 'commands',
    prompt: '/effort status',
    judgeCriteria: {
      mustSatisfy: [
        'The response reports the current reasoning-depth (effort) level for the session.',
        'The response indicates whether the active model supports reasoning depth (the default model does support it).',
      ],
      shouldNot: [
        'The response is an error saying /effort or /effort status is unknown.',
        'The response changed the effort level (status is a read-only report).',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'effort-unsupported-model-notice',
    name: '/effort high on a non-reasoning model surfaces the no-effect notice',
    description:
      'When the active model cannot reason (here claude-3-5-haiku, pinned via config), /effort high ' +
      'must still record the level but append a notice that it has no effect until a reasoning model ' +
      'is selected — never silently pretend reasoning is on (a thinking param sent to a non-reasoning ' +
      'model would 400). Guards against the capability gate / notice being dropped.',
    category: 'commands',
    setup: {
      userConfig: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-3-5-haiku-latest',
        providers: { anthropic: { model: 'claude-3-5-haiku-latest' } },
      },
    },
    prompt: '/effort high',
    judgeCriteria: {
      mustSatisfy: [
        'The response confirms the effort level was set to high for the session.',
        'The response includes a notice that the active model does not support reasoning depth, so the setting has no effect until a reasoning model is selected.',
      ],
      shouldNot: [
        'The response claims reasoning / extended thinking is now active on this model.',
        'The response is an error saying /effort is unknown or the level is invalid.',
      ],
    },
    timeoutMs: 30_000,
  },
];
