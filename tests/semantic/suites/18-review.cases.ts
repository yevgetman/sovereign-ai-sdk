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
      'On a fresh harness with no proposals filed yet, /review list should return a clean ' +
      '"no pending" message — no errors, no fabrication. Guards against: the slash command ' +
      'erroring on the absent review/ directory, or the model claiming proposals exist when ' +
      'they do not.',
    category: 'commands',
    prompt:
      'Run /review list and tell me what it returned, verbatim. Do not summarise or rephrase ' +
      'the output — quote the exact text the slash command printed.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the /review slash command with the list verb (or no verb, equivalent to list).',
        "The agent's response includes the verbatim slash-command output and indicates no pending proposals (e.g., contains the phrase 'no pending').",
      ],
      shouldNot: [
        'The agent claims that pending proposals exist when none have been filed.',
        'The agent reports that /review failed or is unavailable.',
        'The agent invents proposal ids in the response.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'review-show-nonexistent-id-errors-clearly',
    name: '/review show <bogus-id> returns a clear "not found" error',
    description:
      'The slash command should surface a clear error when asked to show a non-existent ' +
      'proposal id — never silent success, never a fabricated proposal. Guards against: ' +
      'the model pretending the proposal exists, or the slash command swallowing the missing-id ' +
      'condition.',
    category: 'commands',
    prompt:
      'Run /review show 9999-99-99-zzz and report the result verbatim. Tell me what the ' +
      'slash command printed exactly.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked /review show with the id 9999-99-99-zzz.',
        "The agent's response surfaces a 'not found' (or equivalent missing-id) message.",
      ],
      shouldNot: [
        "The agent fabricates content of a proposal with id '9999-99-99-zzz'.",
        'The agent claims the proposal was approved or rejected when no such id exists.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'review-consolidate-dispatches-or-degrades',
    name: '/review consolidate either dispatches a pass or degrades gracefully',
    description:
      'On a configured session /review consolidate dispatches the review-consolidate agent ' +
      'and surfaces a "dispatched" status. On a session without a wired ReviewManager (or in ' +
      'cases where the agent is not loaded), it should degrade with a clear message rather ' +
      'than throwing. Either is acceptable — the failure mode is silent success or a stack ' +
      'trace.',
    category: 'commands',
    prompt: 'Run /review consolidate and tell me what came back. Report the message verbatim.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked /review consolidate.',
        "The agent's response includes the slash-command output, which contains either a 'dispatched' / 'queued' status, or a clear 'not available' / 'no review manager' degradation message.",
      ],
      shouldNot: [
        'The agent claims that consolidation completed and produced concrete merge proposals (it cannot — only dispatch fires synchronously).',
        'The agent fabricates a list of consolidation proposals.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'review-unknown-verb-returns-usage',
    name: '/review badverb returns the usage line',
    description:
      'When given an unrecognized verb, /review should respond with the usage hint, not a ' +
      'silent success or an error stack. Guards against: usage hint missing, or the slash ' +
      "command treating unknown verbs as 'list' (the default).",
    category: 'commands',
    prompt: 'Run /review notarealverb and tell me what came back, verbatim.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked /review notarealverb.',
        "The agent's response includes the slash-command output containing the substring '/review' and the word 'usage' (or an equivalent usage-line indicator).",
      ],
      shouldNot: [
        'The agent claims the unknown verb succeeded.',
        'The agent fabricates output as if the verb did something.',
      ],
    },
    timeoutMs: 180_000,
  },
];
