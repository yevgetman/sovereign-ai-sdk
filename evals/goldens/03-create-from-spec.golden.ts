// Golden: agent creates a new file from a description. Exercises the
// Write tool plus simple transcript-content assertion.

import type { GoldenSpec } from '../../src/eval/types.js';

export const createFromSpec: GoldenSpec = {
  id: 'create-from-spec',
  name: 'Agent creates a file with the requested content',
  description:
    'Empty sandbox; agent is asked to create greeting.txt containing the literal phrase "hello eval world". Assert the file exists with that content.',
  category: 'tools',
  prompt: 'Create greeting.txt with exactly the contents: hello eval world',
  assertions: [
    { type: 'fileExists', path: 'greeting.txt' },
    { type: 'fileContains', path: 'greeting.txt', text: 'hello eval world' },
    { type: 'noToolErrors' },
  ],
};
