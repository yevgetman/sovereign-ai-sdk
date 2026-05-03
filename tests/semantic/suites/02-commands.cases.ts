// Slash-command dispatch tests. Two distinct paths to cover:
//   - LOCAL commands (e.g. /help) — registry returns text, no model turn.
//   - PROMPT commands (e.g. /commit) — registry feeds a constrained prompt
//     into the model with a restricted allowedTools scope.
// Both paths are exercised end-to-end through the spawned binary.

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
  {
    id: 'commit-on-non-git-directory',
    name: '/commit gracefully reports when the cwd is not a git repository',
    description:
      'Exercises the prompt-command path: /commit feeds a prompt into the model with allowedTools ' +
      "restricted to git-only Bash subcommands. The model invokes git status, gets 'not a git " +
      "repository', and must report that honestly. Bug class: agent fabricates a commit summary " +
      'when no repo exists, or the prompt-command pipeline routes the invocation incorrectly.',
    category: 'commands',
    prompt: '/commit',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the Bash tool with a git-related command (git status, git diff, etc.).',
        'The transcript shows git reporting that this is not a git repository (or equivalent — "fatal: not a git repository", "not in a git work tree", etc.).',
        "The agent's final response acknowledges that there is no git repository and no commit can be made.",
      ],
      shouldNot: [
        'The agent fabricated a commit message or summary as if a commit succeeded.',
        'The agent claimed to have committed something.',
        'The transcript shows the /commit command being treated as unknown or as a literal model prompt without git tool invocation.',
      ],
    },
    timeoutMs: 60_000,
  },
];
