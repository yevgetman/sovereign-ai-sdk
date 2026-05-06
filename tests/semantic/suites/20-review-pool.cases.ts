// Phase 13.3 (A2) — regression guard for the main-agent pool's exclusion
// of memory_propose and skill_propose. Those tools moved out of
// REGISTERED_TOOLS in commit ec21277; they're now injected into review
// forks' parentToolPool by runReviewFork. If a future change accidentally
// re-adds them to REGISTERED_TOOLS, this case catches it before ~530
// tokens/turn of schema budget bleed away again.
//
// The model uses HarnessInfo (or tool-list introspection) to enumerate
// what's actually available — this is the same self-check that worked
// reliably in round-2 ad-hoc REPL testing.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'main-agent-excludes-propose-tools',
    name: 'main agent does not have memory_propose or skill_propose in its tool pool',
    description:
      'After Phase 13.3 A2 (commit ec21277), memory_propose and skill_propose live in a ' +
      'separate REVIEW_ONLY_TOOLS export and are injected only into review-fork sub-agents. ' +
      'The main agent should NOT see them in its tool pool. Guards against accidental ' +
      're-registration in REGISTERED_TOOLS.',
    category: 'tools',
    prompt:
      'Inspect your available tools. Do you have memory_propose or skill_propose in your tool pool? ' +
      "Use the HarnessInfo tool with section='tools' to see the actual list, then answer with a " +
      'plain yes or no for each tool by name. Do not guess from your training data — read what ' +
      'HarnessInfo actually returns.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the HarnessInfo tool (with section "tools" or similar) to inspect its actual tool pool.',
        "The agent's response answers no for memory_propose (i.e., explicitly says memory_propose is NOT in its tool pool).",
        "The agent's response answers no for skill_propose (i.e., explicitly says skill_propose is NOT in its tool pool).",
      ],
      shouldNot: [
        'The agent claims memory_propose or skill_propose IS available without checking.',
        'The agent fabricates a tool list without invoking HarnessInfo.',
      ],
    },
    timeoutMs: 60_000,
  },
];
