// Golden: agent edits an existing file in place. Exercises the Edit
// tool's identity-preserving substitution.

import type { GoldenSpec } from '../../src/eval/types.js';

export const editConfig: GoldenSpec = {
  id: 'edit-config',
  name: 'Agent renames a config field via Edit',
  description:
    'Seed config.txt with `mode=alpha`. Ask the agent to change it to `mode=beta`. Asserts the file ends up with the new value and the old one is gone.',
  category: 'tools',
  seed: {
    'config.txt': 'mode=alpha\nport=8080\n',
  },
  prompt: 'Edit config.txt: change `mode=alpha` to `mode=beta`. Keep the port line as-is.',
  assertions: [
    { type: 'fileContains', path: 'config.txt', text: 'mode=beta' },
    { type: 'fileContains', path: 'config.txt', text: 'port=8080' },
    { type: 'noToolErrors' },
  ],
};
