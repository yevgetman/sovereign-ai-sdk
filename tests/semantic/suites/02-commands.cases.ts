// Slash-command dispatch tests. /help is a local command (not a model
// turn), so the judge is verifying that the local command pipeline ran
// end-to-end through the spawned binary, not LLM behavior.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'help-listing',
    name: '/help renders the categorized command listing',
    description:
      'Guards against slash-command dispatch breaking, /help losing its categorized layout, or ' +
      'core commands disappearing from the listing.',
    category: 'commands',
    prompt: '/help',
    judgeCriteria: {
      mustSatisfy: [
        'The transcript contains a "slash commands" header.',
        'At least four category section markers appear: session, info, config, files, or git.',
        'The listing includes /help, /quit, /model, /clear, /commit, and /help with its alias suffix shown as "/help (/h /?)".',
      ],
      shouldNot: [
        'The agent treated /help as a model prompt instead of dispatching it locally.',
        'The transcript contains an error about the command being unknown.',
      ],
    },
    timeoutMs: 30_000,
  },
];
