// Phase 1 T16 — Semantic test suite for multi-provider task routing.
//
// These cases run via `bun run test:semantic` against a live LLM (default
// Anthropic). They verify the user-visible behavior of the smart router
// when taskRouting.enabled=true. Each case spawns a fresh sov drive
// subprocess with the specified user config; the judge then evaluates
// whether the recorded transcript meets the criteria.
//
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md (T16)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md
//
// What we assert and why:
//   - Trivial / lookup / compound / hard-reasoning cases pin the user-facing
//     contract that the router picks the right complexity tier for the turn
//     — single cheap atom for trivia, multi-atom + synthesis for compound,
//     at least one frontier atom for hard reasoning. We don't pin the exact
//     atom count beyond "at least one / at least two" because the
//     classifier may legitimately decompose differently across runs.
//   - The failure-recovery case configures the cheap-task lane to an
//     unreachable provider+model so the lane will fail at dispatch; the
//     synthesis layer must surface that honestly instead of fabricating a
//     listing. This is the most insidious bug class the router could
//     introduce, so it has its own dedicated case.
//
// All five cases run as `category: 'workflow'` because the routing decision
// is a multi-step orchestration concern, not a single-tool surface.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'task-routing-trivial',
    name: 'Trivial turn → one cheap-task atom',
    description:
      'With smart router enabled, a trivial general-knowledge question should be dispatched as a ' +
      'single cheap-task atom (no decomposition, no synthesis). Guards against the classifier ' +
      'over-escalating trivia to higher tiers, or the delegator decomposing a one-shot question ' +
      'into multiple atoms unnecessarily.',
    category: 'workflow',
    prompt: 'what is a dog?',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the transcript shows exactly one delegator invocation',
        'the delegator dispatched exactly one cheap-task atom',
        'the final response mentions that a dog is a domesticated mammal or similar',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'task-routing-lookup',
    name: 'Lookup turn → one or two atoms (cheap or moderate)',
    description:
      'A file-lookup task should dispatch one or two atoms on cheap or moderate lanes. No ' +
      'frontier-task involvement — looking files up is not a reasoning task. Guards against the ' +
      'classifier escalating routine lookups to the expensive frontier lane.',
    category: 'workflow',
    prompt: 'find files in src/ that mention AgentTool',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the transcript shows delegator delegation to a cheap-task or moderate-task atom',
        'the final response lists files containing AgentTool',
      ],
      shouldNot: ['frontier-task was unnecessarily invoked'],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'task-routing-compound',
    name: 'Compound turn → multi-atom + synthesis',
    description:
      'A compound task that requires reading multiple sources and reasoning across them should ' +
      'decompose into multiple atoms plus a synthesis atom on a higher-tier lane. Guards against ' +
      'the delegator collapsing genuinely compound work into a single atom, which would lose the ' +
      'parallelism benefit and starve the synthesis lane.',
    category: 'workflow',
    prompt: 'summarize what this project does based on the README and src/ directory structure',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the delegator dispatched at least two atoms before producing the final response',
        'at least one frontier-task atom OR moderate-task synthesis atom was used',
        'the final response is a coherent project summary',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'task-routing-hard-reasoning',
    name: 'Hard reasoning → at least one frontier-task atom',
    description:
      'A hard-reasoning task with no file-lookup component should route to frontier-task (either ' +
      'as a single atom or as the synthesis lane on top of moderate atoms). Guards against the ' +
      'classifier under-tiering design / architecture questions to the cheap lane, which would ' +
      'produce shallow output for work that genuinely needs frontier reasoning.',
    category: 'workflow',
    prompt: 'design a permission model for an OAuth-only multi-tenant SaaS application',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'at least one frontier-task atom was invoked',
        'the final response describes a coherent permission model with multiple components',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'task-routing-failure-recovery',
    name: 'Atom failure surfaces honestly in the synthesis',
    description:
      'When a configured lane is unreachable (here: cheap-task pointed at an ollama model that ' +
      'is not installed), the response must acknowledge the failure rather than fabricating ' +
      'output. This is the most insidious bug class the router could introduce — a silent failure ' +
      'mode where the synthesis layer invents a plausible-looking answer instead of surfacing ' +
      'that the dispatched atoms never returned real data.',
    category: 'workflow',
    prompt: 'what files are in src/',
    setup: {
      userConfig: {
        taskRouting: {
          enabled: true,
          lanes: {
            'cheap-task': {
              provider: 'ollama',
              model: 'definitely-not-installed-model-xyz',
            },
          },
        },
      },
    },
    judgeCriteria: {
      mustSatisfy: ['the response acknowledges that the task could not be fully completed'],
      shouldNot: ['the response fabricates a fake file listing'],
    },
    timeoutMs: 60_000,
  },
];
