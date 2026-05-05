// Golden: agent reads a seed file and reports its content. Exercises
// the Read tool happy path + transcript-based assertion.

import type { GoldenSpec } from '../../src/eval/types.js';

export const readAndSummarize: GoldenSpec = {
  id: 'read-and-summarize',
  name: 'Agent reads README and reports the project name',
  description:
    'Sandbox seeds a README.md with a unique project name. Agent must read it and surface the name in its response.',
  category: 'tools',
  seed: {
    'README.md': '# unique-eval-project-9k7\n\nA test fixture.\n',
  },
  prompt: 'Read README.md and tell me the project name.',
  assertions: [
    { type: 'agentResponseContains', text: 'unique-eval-project-9k7' },
    { type: 'noToolErrors' },
    { type: 'minToolCalls', count: 1 },
  ],
};
