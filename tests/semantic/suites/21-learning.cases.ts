// Phase 13.4 — Learning system semantic tests. Regression guards for
// LEARNING_ONLY_TOOLS pool isolation and the bundled instinct-synthesizer
// agent. CLI subcommands (`harness learning status / prune / export`)
// aren't exercised here — those run outside the in-chat semantic runner
// and have unit-level coverage in tests/cli/learningCommands.test.ts.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'main-agent-excludes-instinct-tools',
    name: 'main agent does not have instinct_* tools in its tool pool',
    description:
      'After Phase 13.4 T5 (LEARNING_ONLY_TOOLS pool isolation), the four instinct tools ' +
      '(instinct_list / instinct_view / instinct_propose / instinct_update_confidence) live ' +
      'in a separate LEARNING_ONLY_TOOLS export and are injected only into the instinct-synthesizer ' +
      'sub-agent pool. The main agent should NOT see them. Guards against accidental ' +
      're-registration in REGISTERED_TOOLS.',
    category: 'tools',
    prompt:
      'Inspect your available tools. Do you have instinct_list, instinct_view, instinct_propose, or ' +
      "instinct_update_confidence in your tool pool? Use the HarnessInfo tool with section='tools' to " +
      'see the actual list, then answer with a plain yes or no for each tool by name. Do not guess ' +
      'from your training data — read what HarnessInfo actually returns.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the HarnessInfo tool (with section "tools" or similar) to inspect its actual tool pool.',
        "The agent's response answers no for instinct_list (i.e., explicitly says instinct_list is NOT in its tool pool).",
        "The agent's response answers no for instinct_view.",
        "The agent's response answers no for instinct_propose.",
        "The agent's response answers no for instinct_update_confidence.",
      ],
      shouldNot: [
        'The agent claims any instinct_* tool IS available without checking.',
        'The agent fabricates a tool list without invoking HarnessInfo.',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'instinct-synthesizer-agent-bundled',
    name: 'instinct-synthesizer agent is loaded as a bundled sub-agent',
    description:
      'After Phase 13.4 T6, the instinct-synthesizer agent ships in bundle-default/agents/. ' +
      'Verify the harness exposes it via HarnessInfo so the main agent can see it as a ' +
      'delegation target alongside explore / plan / verify / review-* agents.',
    category: 'tools',
    prompt:
      'Use the HarnessInfo tool with section="agents" to list the bundled sub-agents. Tell me ' +
      'whether instinct-synthesizer is one of them, quoting the HarnessInfo output verbatim.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked HarnessInfo with the agents section.',
        "The agent's response confirms instinct-synthesizer is present in the bundled agents list.",
      ],
      shouldNot: [
        'The agent claims instinct-synthesizer is absent without checking.',
        'The agent invents the agent list without calling HarnessInfo.',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'learning-cli-not-confused-with-slash-command',
    name: 'agent recognizes harness learning is a CLI subcommand, not a slash command',
    description:
      'The harness has BOTH slash commands (e.g., /review activity) and CLI subcommands ' +
      '(e.g., harness learning status). When a user asks about /learning the agent should ' +
      'recognize it is not a registered slash command and either (a) report it as unknown, or ' +
      '(b) clarify that the related functionality lives at `harness learning status`. The agent ' +
      'must not pretend the slash command exists or fabricate output.',
    category: 'tools',
    prompt:
      'I tried running /learning status in the prompt and nothing happened. What is the correct ' +
      'invocation? Do not run any tools — just tell me the answer based on what you know about ' +
      'the harness.',
    judgeCriteria: {
      mustSatisfy: [
        "The agent's response indicates that /learning is not a slash command (or is unknown), or that the corresponding functionality lives at the CLI level (e.g., 'harness learning' or 'sov learning').",
      ],
      shouldNot: [
        'The agent fabricates output as if /learning status had succeeded.',
        'The agent claims /learning is a registered slash command.',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'instinct-tools-described-as-internal-only',
    name: 'when asked about instinct tools, agent reports they are internal-only',
    description:
      'A direct question "tell me about the instinct tools" should result in the agent ' +
      'either reporting they are not in its pool (after checking via HarnessInfo) or describing ' +
      'them as "internal" / "synthesizer-only" / "not for direct invocation by main agents". ' +
      'Guards against the main agent assuming it can call instinct_propose on demand.',
    category: 'tools',
    prompt:
      'Tell me about the instinct tools (instinct_list, instinct_view, instinct_propose, instinct_update_confidence). ' +
      'Are they part of your toolset? Use HarnessInfo to verify before answering.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked HarnessInfo to check its actual tool pool.',
        "The agent's response makes clear that the instinct tools are NOT available to the main agent (it does not have them in its pool, OR the response describes them as internal / synthesizer-only / not directly invokable).",
      ],
      shouldNot: [
        'The agent claims it can call instinct_propose or instinct_update_confidence directly.',
        'The agent fabricates instinct corpus contents.',
      ],
    },
    timeoutMs: 60_000,
  },
];
