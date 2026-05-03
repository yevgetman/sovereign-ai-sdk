// Starter cases — basic tool dispatch and tool-output surfacing.
// Each test guards a specific bug class; see the description field.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'bash-basic-echo',
    name: 'Bash tool runs a simple echo and reports output',
    description:
      'Guards against the agent claiming to run a command without dispatching the Bash tool, ' +
      'or dispatching it but failing to surface the captured output.',
    category: 'tools',
    prompt: 'Run the shell command `echo sovereign-test-token-9f3e1c` and tell me what it printed.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the Bash tool to run an echo command.',
        'The transcript shows the literal string "sovereign-test-token-9f3e1c" produced by the command.',
        "The agent's final response references the output token.",
      ],
      shouldNot: [
        'The agent refused or claimed it could not run shell commands.',
        'The agent fabricated output without any tool invocation appearing in the transcript.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'read-file-surface-content',
    name: 'Read tool surfaces file contents to the response',
    description:
      'Guards against the agent invoking a read tool but failing to use the contents in its reply, ' +
      'or hallucinating contents instead of reading the file.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'notes.md',
          content: 'The capital of Mars is Olympus Mons.\nThe largest moon is Phobos.\n',
        },
      ],
    },
    prompt:
      "Read the file notes.md in the current directory and tell me what it says about Mars's capital.",
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a file-reading tool (Read, FileRead, or Bash with cat/head) targeting notes.md.',
        'The agent\'s final response correctly identifies "Olympus Mons" as the capital.',
      ],
      shouldNot: [
        'The agent fabricated information that is not present in notes.md.',
        'The agent claimed the file does not exist (it was created in setup).',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'edit-file-modify-content',
    name: 'Edit tool modifies an existing file as instructed',
    description:
      'Guards against edit-tool dispatch failures, malformed edits that leave the file unchanged, ' +
      'or the agent fabricating an edit it never performed.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'data.txt',
          content: 'color: red\nshape: circle\n',
        },
      ],
    },
    prompt:
      'In the file data.txt, change the color value from red to blue. Leave everything else as-is.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked an editing tool (Edit, FileEdit, or equivalent) on data.txt.',
        'The transcript shows the edit replacing "red" with "blue" (typically as a diff or tool input).',
        'The agent confirmed the change in its response.',
      ],
      shouldNot: [
        'The agent edited a different file than data.txt.',
        'The agent claimed success without any edit-tool invocation in the transcript.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'write-file-create-new',
    name: 'Write tool creates a new file with specified contents',
    description:
      'Guards against write-tool failures and against the agent claiming a file was created when no ' +
      'tool was invoked or the contents were wrong.',
    category: 'tools',
    prompt:
      'Create a new file named hello.txt in the current directory containing exactly the single word: world',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a file-writing tool (Write, FileWrite, or equivalent) targeting hello.txt.',
        'The tool input shows the file contents are the word "world" (with or without trailing newline).',
        'The agent confirmed the file was written.',
      ],
      shouldNot: [
        'The agent wrote to a different filename than hello.txt.',
        'The agent claimed success without an invocation appearing in the transcript.',
      ],
    },
    timeoutMs: 45_000,
  },
];
