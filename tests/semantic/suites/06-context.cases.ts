// Context-injection tests — verify the harness's user-message expansion
// pipeline (currently @file references). The agent reaches the right
// answer EITHER because @-expansion injected the file content into the
// user message, OR because the agent invoked Read on the referenced
// file. Both are valid outcomes; what we catch is when the agent claims
// the @-reference was unrecognized or fabricates content.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'at-file-expansion-or-read',
    name: '@file reference yields the file contents to the agent',
    description:
      'Guards against the @-mention pipeline silently failing — either via expansion before the ' +
      'model sees the prompt, or by the agent invoking Read on the referenced file. Either path is ' +
      'acceptable; what we forbid is the agent reporting the reference as unrecognized or inventing ' +
      'an answer.',
    category: 'context',
    setup: {
      files: [
        {
          path: 'spec.md',
          content:
            'Project facts:\n- The capital of Mars is Olympus Mons.\n- The largest moon is Phobos.\n- The project codename is "atmospheric".\n',
        },
      ],
    },
    prompt: 'Look at @spec.md and tell me what the capital of Mars is according to the file.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent\'s final response correctly identifies "Olympus Mons" as the capital of Mars.',
      ],
      shouldNot: [
        'The agent fabricated information not present in spec.md.',
        'The agent reported that the @spec.md reference was unrecognized or could not be resolved.',
        'The agent answered "I don\'t know" or similar without consulting the file.',
      ],
    },
    timeoutMs: 45_000,
  },
];
