// Phase 13.3 — Review system semantic tests. The /review slash command
// (list / show / approve / reject / consolidate) and the propose-tools
// (memory_propose / skill_propose) shipped with unit + integration
// coverage; this suite exercises the model's ability to invoke them in
// real conversation.
//
// Auto-review forks (counter-driven dispatches inside the runtime) are
// NOT exercised here — they fire from internal counters, not from
// model-driven prompts, and the build plan's Check is more cleanly
// covered by the integration test in tests/review/integration.test.ts.
// What's worth covering at the semantic layer is: does the model
// actually use the /review verbs correctly when asked, and does the
// runtime surface the right errors when verbs are misused.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'review-list-empty-on-fresh-bundle',
    name: '/review list reports no pending proposals on a fresh harness',
    description:
      'On a fresh harness with no proposals filed yet, /review list dispatches as a local ' +
      'slash command and returns "no pending proposals". Guards against: the slash command ' +
      'erroring on the absent review/ directory, the listPending logic crashing on missing ' +
      'state, or the registry losing the /review entry.',
    category: 'commands',
    prompt: '/review list',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript contains the phrase 'no pending' (case-insensitive — the dimmed message 'no pending proposals' should appear verbatim).",
      ],
      shouldNot: [
        'The agent treated /review as a model prompt instead of dispatching it locally.',
        "The transcript contains 'unknown command' referring to /review.",
        'The transcript contains a stack trace or unhandled exception.',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'review-show-nonexistent-id-errors-clearly',
    name: '/review show <bogus-id> returns a clear "not found" error',
    description:
      'When the slash command is given a non-existent proposal id, it must surface a clear ' +
      "'not found' message — never silent success, never a stack trace. Guards against the " +
      'findProposal helper returning a falsy result that gets stringified to "null" or similar ' +
      'unhelpful output.',
    category: 'commands',
    prompt: '/review show 9999-99-99-zzz',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript contains 'not found' (the slash command's error message: 'proposal 9999-99-99-zzz not found').",
        "The transcript references the id '9999-99-99-zzz'.",
      ],
      shouldNot: [
        'The transcript fabricates content of a proposal with id 9999-99-99-zzz.',
        'The transcript contains a stack trace or unhandled exception.',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'review-unknown-verb-returns-usage',
    name: '/review notarealverb returns the usage line',
    description:
      'When given an unrecognized verb, /review should respond with the usage hint, not a ' +
      'silent success or error stack. Guards against: usage hint missing, or the slash ' +
      "command treating unknown verbs as 'list' (the default).",
    category: 'commands',
    prompt: '/review notarealverb',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript contains 'usage' (the usage line).",
        "The transcript contains '/review' (referring to the command name in the usage line).",
        "The transcript references at least one of the valid verbs: 'list', 'show', 'approve', 'reject', or 'consolidate' (the usage line lists them).",
      ],
      shouldNot: [
        'The transcript shows the empty/list output (the unknown verb must NOT default to list).',
        'The transcript fabricates output as if notarealverb did something.',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'review-bare-call-shows-list-or-empty',
    name: '/review (no args) lists pending proposals or reports none',
    description:
      'Bare /review should be equivalent to /review list — the same handler returns either ' +
      'the table of pending entries or the dim "no pending proposals" message.',
    category: 'commands',
    prompt: '/review',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript contains 'no pending' (fresh harness has no proposals; bare /review should match the list-empty path).",
      ],
      shouldNot: [
        'The transcript contains the usage line — bare /review with no verb should NOT trigger the unknown-verb fallback.',
        'The transcript contains a stack trace or unhandled exception.',
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'review-activity-empty-on-fresh-bundle',
    name: '/review activity reports no review-fork sessions on a fresh harness',
    description:
      'On a fresh harness with no prior delegation, /review activity should return a clean ' +
      "'no review-fork sessions for this parent yet' message (or, if some phantom rows from " +
      "cancelled dispatches exist, the equivalent 'no productive review sessions' branch). " +
      'Guards against: the slash command erroring on the absent sessions table, the listSessions ' +
      'bridge breaking, or the model fabricating review activity that never happened.',
    category: 'commands',
    prompt: '/review activity',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript contains either 'no review-fork sessions' (the empty path) or 'no productive review sessions' (the all-phantoms path) — both are valid outcomes on a fresh harness.",
      ],
      shouldNot: [
        'The transcript fabricates a list of review sessions that never occurred.',
        'The transcript contains a stack trace or unhandled exception.',
        "The transcript contains 'unknown command' referring to /review activity.",
      ],
    },
    timeoutMs: 30_000,
  },
  {
    id: 'review-consolidate-dispatches-or-degrades',
    name: '/review consolidate dispatches a pass or degrades cleanly',
    description:
      'When invoked on a session with a wired ReviewManager, /review consolidate dispatches the ' +
      'review-consolidate sub-agent and surfaces a "dispatched" status. When the manager is not ' +
      'available (e.g., agents not loaded in the sandbox), it should degrade with a clear ' +
      "'not available' message. Either is acceptable; the failure mode is silent success or a " +
      'stack trace.',
    category: 'commands',
    prompt: '/review consolidate',
    judgeCriteria: {
      mustSatisfy: [
        "The transcript includes either 'dispatched' (with mention of /review list) or 'not available' (graceful degradation) — never both.",
      ],
      shouldNot: [
        'The transcript claims that consolidation completed and produced concrete merge proposals (it cannot — only the dispatch fires synchronously).',
        'The transcript fabricates a list of consolidation proposals.',
        'The transcript contains a stack trace or unhandled exception.',
      ],
    },
    timeoutMs: 30_000,
  },
];
