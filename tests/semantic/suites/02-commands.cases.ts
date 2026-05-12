// Slash-command dispatch tests. Two distinct paths to cover:
//   - LOCAL commands (e.g. /help) — registry returns text, no model turn.
//   - PROMPT commands (e.g. /commit) — registry feeds a constrained prompt
//     into the model with a restricted allowedTools scope.
// Both paths are exercised end-to-end through the spawned binary.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'context-budget-dispatch',
    name: '/context-budget renders a section-grouped audit of context-window usage',
    description:
      'Phase 12.6 — context budget. The command must dispatch as a local slash command (no model ' +
      "turn), produce a 'total estimate' header, and group components by kind. Guards against " +
      'regressions in src/context/budget.ts (auditContextBudget / formatBudgetReport), the new ' +
      'CommandContext.getBudgetReport hook, and the command registry wiring.',
    category: 'commands',
    prompt: '/context-budget',
    judgeCriteria: {
      mustSatisfy: [
        'The transcript contains the literal string "total estimate".',
        'The output shows BOTH a "system prompt" section AND a "tool schemas" section as group headings. Additional sections like "skills" or "memory files" may be absent and that is expected — the test sandbox has none.',
        'Each tool-schema entry begins with "Name: <number>" (e.g. "Bash: 280", "Read: 156" — exact tools and counts vary). Trailing annotations after the number such as "[sometimes]" or "[always]" are allowed and do NOT disqualify the line.',
      ],
      shouldNot: [
        'The agent treated /context-budget as a model prompt instead of dispatching it locally.',
        'The transcript contains "unknown command" referring to context-budget.',
      ],
    },
    timeoutMs: 30_000,
  },
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
    id: 'init-creates-context-md',
    name: '/init scans the project and writes CONTEXT.md',
    description:
      'Second prompt-command coverage (after /commit). /init feeds a constrained prompt with ' +
      'allowedTools: [Glob, FileRead, FileWrite, Bash(ls *), Bash(git status), Bash(git log -*)] ' +
      'and instructs the model to scan the project and write a briefing. Tests the full pipeline: ' +
      'prompt-command dispatch, multi-step tool sequencing, file write with synthesized content.',
    category: 'commands',
    setup: {
      files: [
        {
          path: 'package.json',
          content: JSON.stringify(
            {
              name: 'sovereign-init-test-project',
              version: '0.0.1',
              description: 'Minimal fixture used by the /init semantic test.',
            },
            null,
            2,
          ),
        },
        {
          path: 'README.md',
          content:
            '# sovereign-init-test-project\n\nMinimal fixture used by the /init semantic test.\n',
        },
        {
          path: 'src/main.ts',
          content: 'console.log("hello from init test fixture");\n',
        },
      ],
    },
    prompt: '/init',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked at least one scanning tool (Glob, FileRead, or Bash with ls/git) to inspect the project.',
        'The agent invoked a file-writing tool (FileWrite/Write) targeting CONTEXT.md (path may be ./CONTEXT.md or CONTEXT.md).',
        'The CONTEXT.md content references the project — at minimum the name "sovereign-init-test-project" or content from README.md.',
        "The agent's final response confirms the briefing was written.",
      ],
      shouldNot: [
        'The agent fabricated CONTEXT.md content without scanning the actual files.',
        'The agent wrote to a different filename than CONTEXT.md.',
        'The transcript shows the /init command being treated as unknown or not dispatched.',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'slash-help-and-clear',
    name: '/help, /clear, and /cost round-trip through the Ink TUI registry',
    description:
      'Phase 16.0c Wave 1 — slash-command dispatch lives in the Ink TUI (src/ui/ink/hooks/useAgentTurn.ts). ' +
      'Three local commands chained in one session catch the most likely regressions: ' +
      '(1) /help means the registry is loaded and rendered; (2) /clear means the LocalCommand ' +
      'path invokes ctx.clearHistory() and the transcript_cleared dispatch reaches the reducer; ' +
      '(3) /cost after /clear means sessionCost was zeroed by transcript_cleared (reducer.ts:88). ' +
      'A regression in any of the three would break the visible behavior asserted below.',
    category: 'commands',
    prompt: ['/help', 'hello', '/clear', '/cost'],
    judgeCriteria: {
      mustSatisfy: [
        'The transcript shows /help rendering a categorized listing that includes /help, /clear, and /cost as registered commands.',
        'After the /clear invocation, the transcript contains the literal string "history cleared".',
        'The /cost output that appears AFTER /clear shows "input: 0 tokens" (a zero input-token count), confirming that /clear reset the session cost.',
      ],
      shouldNot: [
        'The agent treated /help, /clear, or /cost as a model prompt instead of dispatching them locally.',
        'The transcript contains an "unknown command" error for /help, /clear, or /cost.',
        'The final /cost output shows a non-zero input-token count, which would indicate /clear did not reset the session cost.',
      ],
    },
    timeoutMs: 60_000,
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
