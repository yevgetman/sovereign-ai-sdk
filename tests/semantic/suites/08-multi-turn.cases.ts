// Multi-turn coherence tests. Each test specifies `prompt: string[]` —
// one element per conversational turn, sent in order. The driver pipes
// them all to stdin (newline-separated) followed by /quit; sov consumes
// them sequentially, waiting for each turn to finish before reading the
// next. The judge sees the full transcript and evaluates against the
// listed criteria.
//
// Bug classes targeted: cross-turn memory loss, tool-result amnesia
// (agent re-derives instead of using prior result), and the inability
// to recover from a failed first turn.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'cross-turn-memory',
    name: 'Agent recalls a token from Turn 1 in Turn 2',
    description:
      'Simplest multi-turn coherence test. The agent must remember a token introduced in Turn 1 ' +
      'and recall it correctly in Turn 2. Bug class: conversation history not preserved between ' +
      'turns, or context truncation that drops the introduction.',
    category: 'workflow',
    prompt: [
      'Please remember this token for my next question: alpha-beta-9k2x. Just confirm you have it.',
      'What was the token I asked you to remember?',
    ],
    judgeCriteria: {
      mustSatisfy: [
        'In response to Turn 1, the agent confirms it has noted the token (or simply acknowledges).',
        'In response to Turn 2, the agent correctly recalls the literal string "alpha-beta-9k2x".',
      ],
      shouldNot: [
        'The agent fabricated a different token in Turn 2.',
        'The agent claimed in Turn 2 that it has no access to or memory of Turn 1.',
      ],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'refinement-after-tool-result',
    name: 'Turn 2 acts on the tool result produced in Turn 1',
    description:
      'After Turn 1 reads a file and reports a value, Turn 2 asks the agent to modify that value. ' +
      'Tests that the agent retains the prior tool result as context and dispatches an edit on the ' +
      'right field. Bug class: tool-result amnesia (agent re-discovers in Turn 2 instead of using ' +
      'prior context) or wrong-field edits.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'data.txt',
          content: 'color: red\nshape: circle\nsize: medium\n',
        },
      ],
    },
    prompt: [
      'Read data.txt and tell me what the color is set to.',
      'Now change that color value to blue. Leave everything else unchanged.',
    ],
    judgeCriteria: {
      mustSatisfy: [
        'In Turn 1, the agent invoked a Read or equivalent tool on data.txt and reported the color as "red".',
        'In Turn 2, the agent invoked an editing tool (Edit/FileEdit) on data.txt, replacing "red" with "blue".',
        'The Turn 2 response confirms the change was applied.',
      ],
      shouldNot: [
        'The agent edited the wrong field (changed shape or size instead of color).',
        'The agent claimed to make the edit in Turn 2 without invoking an editing tool.',
        'The agent forgot the file path between turns and asked the user to repeat it.',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'compact-preserves-key-facts',
    name: '/compact summarizes prior turns and preserves key facts in the child session',
    description:
      'End-to-end test of context compaction. Turn 1 introduces a distinctive token; Turn 2 fires ' +
      '/compact (which spawns a child session with summarized history); Turn 3 asks the agent to ' +
      'recall the token. The agent should recall it from the summary embedded in the child session. ' +
      'Bug class: compaction loses the fact, child session starts blank, /compact dispatches but ' +
      'subsequent turns operate against the wrong session, or the auxiliary summarizer fails silently.',
    category: 'workflow',
    prompt: [
      'Please remember this important token verbatim for later: compact-preservation-token-9zk7m. Just confirm you have it noted.',
      '/compact',
      'What was the important token I asked you to remember earlier?',
    ],
    judgeCriteria: {
      mustSatisfy: [
        'In Turn 1, the agent confirms it has noted the token.',
        'After Turn 2 (/compact), the transcript shows compaction occurring — look for indicators like "compacted", "session", "child", a session-id transition arrow, or similar.',
        'In Turn 3, the agent correctly recalls the literal token "compact-preservation-token-9zk7m" — proving the summarized history retained it through the child-session boundary.',
      ],
      shouldNot: [
        'In Turn 3, the agent claims it has no memory of the token.',
        'In Turn 3, the agent fabricates a different token.',
        'The transcript shows /compact failing or being treated as an unknown command.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'error-recovery-across-turns',
    name: 'Turn 1 fails (missing file); Turn 2 fixes the situation',
    description:
      'Turn 1 asks the agent to read a file that does not exist; the read should fail. Turn 2 ' +
      'instructs the agent to create the file and then read it. Tests that a failed first turn ' +
      'does not poison the conversation: the agent recovers cleanly and accomplishes the corrected ' +
      'task. Bug class: a tool error in Turn 1 leaves the agent in a confused state that breaks ' +
      'subsequent turns.',
    category: 'workflow',
    prompt: [
      'Read the file recovery-test.txt and tell me what is in it.',
      'Okay, please create recovery-test.txt with the content "second-turn-success-token-77zx" then read it back to confirm.',
    ],
    judgeCriteria: {
      mustSatisfy: [
        'In Turn 1, the agent attempted to read recovery-test.txt and reported that the file does not exist (or could not be read).',
        'In Turn 2, the agent invoked a write tool to create recovery-test.txt with the requested content.',
        'In Turn 2, the agent invoked a read tool on recovery-test.txt after creating it.',
        'The Turn 2 response confirms the content includes "second-turn-success-token-77zx".',
      ],
      shouldNot: [
        'The agent fabricated content for recovery-test.txt in Turn 1 (the file did not exist).',
        'In Turn 2, the agent skipped the create step or skipped the read-back step.',
        'The agent claimed Turn 2 success without invoking a write tool in the transcript.',
      ],
    },
    timeoutMs: 120_000,
  },
];
