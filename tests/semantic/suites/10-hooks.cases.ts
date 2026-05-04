// Hook tests (Phase 11). Each case wires a real Bash hook script through
// the harness's PreToolUse / PostToolUse pipe and asserts the user-visible
// behavior end-to-end. Unit tests in tests/hooks/ cover the runner shape;
// these tests catch regressions in the orchestrator/REPL plumbing — the
// places where it's easiest to silently lose a hook event.
//
// Sandbox specifics:
//   - Hook command is `bash ./hook.sh` (not `./hook.sh`). Setup.files writes
//     scripts mode 0644, so we invoke `bash` interpretively to skip needing
//     execute bits. The relative path resolves against the sandbox cwd.
//   - The consent allowlist is pre-populated via `setup.homeFiles` so the
//     first-use TTY prompt doesn't fire (tests run with piped stdin).

import type { SemanticTest } from '../framework/types.js';

const denyHookScript = `#!/usr/bin/env bash
# PreToolUse deny hook for the semantic test sandbox.
# Reads JSON from stdin, returns a deny decision when the tool is Bash.
read -r -d '' payload
if [[ "$payload" == *'"tool_name":"Bash"'* ]]; then
  echo '{"permissionDecision":"deny","reason":"semantic-test policy: Bash blocked by hook"}'
  exit 0
fi
echo '{}'
`;

const auditHookScript = `#!/usr/bin/env bash
# PostToolUse audit hook. Captures every Bash invocation to /tmp/<sandbox>.log.
# The path is supplied via env so the sandbox can scope it; we fall back to a
# fixed file for local debugging.
read -r -d '' _payload
echo '{"additionalContext":"[audit-hook] tool call recorded"}'
`;

export const tests: SemanticTest[] = [
  {
    id: 'hook-pretooluse-blocks-bash',
    name: 'PreToolUse hook blocks Bash and the agent acknowledges the denial',
    description:
      'Guards against a regression where the orchestrator forgets to call PreToolUse, ignores its ' +
      'deny verdict, or fails to surface the hook reason to the model. We use a hook that always ' +
      'denies Bash so the agent has a strong reason to mention the block in its reply.',
    category: 'hooks',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              hooks: {
                PreToolUse: [
                  {
                    matcher: 'Bash',
                    hooks: [{ type: 'command', command: 'bash ./hook.sh' }],
                  },
                ],
              },
              permissions: { allow: ['Bash(echo *)'] },
            },
            null,
            2,
          ),
        },
        { path: 'hook.sh', content: denyHookScript },
      ],
      homeFiles: [
        {
          path: 'shell-hooks-allowlist.json',
          content: JSON.stringify(
            {
              version: 1,
              decisions: { 'PreToolUse:bash ./hook.sh': 'allow' },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt: 'Run the shell command `echo sovereign-hook-token-7g9k2` and tell me what it printed.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked (or attempted to invoke) the Bash tool with an echo command.',
        'The transcript shows the operation was blocked, denied, or rejected (look for words like "denied", "blocked", "hook", or an error result attached to the echo tool call).',
        "The agent's final response acknowledges the failure rather than claiming success.",
      ],
      shouldNot: [
        'The agent reported the literal string "sovereign-hook-token-7g9k2" as command output (the hook should have blocked the echo before it ran).',
        'The agent claimed the echo succeeded.',
      ],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'hook-posttooluse-additional-context',
    name: 'PostToolUse hook appends additionalContext that the model can read',
    description:
      'Verifies the round-trip: a PostToolUse hook returns additionalContext, the orchestrator splices ' +
      'it into the tool_result content, and the model reads it on the next turn. Catches regressions ' +
      'where the hook fires but its output is dropped before reaching the model.',
    category: 'hooks',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              hooks: {
                PostToolUse: [
                  {
                    matcher: 'Bash',
                    hooks: [{ type: 'command', command: 'bash ./hook.sh' }],
                  },
                ],
              },
              permissions: { allow: ['Bash(echo *)'] },
            },
            null,
            2,
          ),
        },
        { path: 'hook.sh', content: auditHookScript },
      ],
      homeFiles: [
        {
          path: 'shell-hooks-allowlist.json',
          content: JSON.stringify(
            {
              version: 1,
              decisions: { 'PostToolUse:bash ./hook.sh': 'allow' },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt:
      'Run the shell command `echo audit-trace-x8n3q` and report exactly what the tool result contains, ' +
      'including any extra annotations attached to the output.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the Bash tool with an echo command.',
        "The agent's final response includes both the echo output (audit-trace-x8n3q) AND the audit-hook annotation (look for 'audit-hook' or 'tool call recorded').",
      ],
      shouldNot: [
        'The agent ignored the audit annotation entirely.',
        'The agent fabricated annotation text not present in the tool result.',
      ],
    },
    timeoutMs: 90_000,
  },
];
