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
  {
    id: 'bash-error-reported',
    name: 'Agent reports a Bash command failure rather than fabricating output',
    description:
      'Guards against the most insidious tool-error bug: a non-zero exit produces no stdout, ' +
      "and the agent invents output instead of acknowledging the failure. Targets a path that doesn't " +
      'exist so cat returns "No such file or directory" with exit 1.',
    category: 'tools',
    prompt:
      'Run the shell command `cat /tmp/sovereign-nonexistent-zzz-xyz1234567` and tell me what happened.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the Bash tool to run cat against the nonexistent path.',
        'The transcript shows the command failed (e.g., "No such file or directory", non-zero exit, or an error result).',
        "The agent's final response acknowledges the failure or that the file does not exist.",
      ],
      shouldNot: [
        'The agent fabricated file contents (the file does not exist; any specific content claimed is invention).',
        'The agent claimed the command succeeded.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'envelope-recovery-from-edit-mismatch',
    name: 'Agent recovers from a FileEdit mismatch (envelope next_actions or proactive re-read)',
    description:
      "Phase 12.5 — Tool observation envelope. When a FileEdit's old_string does not match, the " +
      "envelope returns status:error + next_actions ['Re-read the file (FileRead) to see current " +
      "contents...']. We accept either of two correct behaviors: (A) the agent attempts the literal " +
      'edit first, sees the envelope failure, and follows the next_action to recover; or (B) the ' +
      'agent inspects the file proactively and produces the correct edit on the first try. Both ' +
      'demonstrate the harness handling the mismatch correctly. The bug class is the agent retrying ' +
      'the same wrong old_string blindly or fabricating success.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'config.txt',
          content: 'SETTING=alpha\nDEBUG=false\n',
        },
      ],
    },
    prompt:
      'I just opened config.txt — it contains exactly:\n```\nSETTING_NAME=alpha\nDEBUG=false\n```\nPlease change SETTING_NAME=alpha to SETTING_NAME=beta in that file.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent inspected config.txt at some point — either via FileRead/Bash before editing, or via a failed FileEdit attempt that surfaced the actual file contents in the error.',
        'The transcript ends with the file in a coherent state: either the file contains "SETTING=beta" (the agent recognised the key mismatch and applied the right edit), or the agent stopped and asked the user to confirm the SETTING vs SETTING_NAME discrepancy without making destructive changes.',
        'If the agent attempted a literal edit with the user-asserted (wrong) old_string and it failed, the agent then re-read the file or otherwise corrected course rather than retrying the same string.',
      ],
      shouldNot: [
        'The agent retried the same wrong old_string ("SETTING_NAME=alpha") more than once without inspecting the file in between.',
        'The agent claimed the edit succeeded when no successful edit invocation appears in the transcript.',
        'The agent left the file with the literal text "SETTING_NAME=beta" — that introduces a key that did not exist in the source.',
      ],
    },
    // 2026-05-22 PM: bumped from 60s to 120s after sov drive replaced
    // the deleted in-process readline REPL. Multi-turn recovery (try
    // edit → envelope error → re-read → corrected edit → confirm) takes
    // ~4-5 LLM calls; with HTTP+SSE round-trip overhead between the
    // stdin loop and the runtime, 60s was borderline. 120s gives the
    // model + provider latency comfortable headroom while still
    // catching a real wedge (e.g., the agent retrying blindly in a
    // tight loop).
    timeoutMs: 120_000,
  },
  {
    id: 'edit-missing-string-no-fabrication',
    name: 'Agent does not fabricate a successful edit when the target string is absent',
    description:
      'The bug class is the agent CLAIMING SUCCESS when it cannot actually apply the edit. The ' +
      'agent may take either valid path: (a) attempt the Edit tool, see it error, report the failure; ' +
      'or (b) Read first, discover the string is absent, report without attempting. Both are correct. ' +
      'What we forbid is fabricating success or silently substituting a different string.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'config.json',
          content: '{"name": "alpha", "version": "1.0"}\n',
        },
      ],
    },
    prompt: 'In config.json, replace "DEPRECATED_FIELD" with "REPLACEMENT". Tell me what happened.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent inspected config.json (via Read, Edit-attempt, or Bash cat) — i.e., it actually checked rather than answering blindly.',
        "The agent's final response correctly states that DEPRECATED_FIELD is not present in the file and the edit was not applied.",
      ],
      shouldNot: [
        'The agent claimed the edit succeeded.',
        'The agent fabricated a diff or before/after content that did not actually happen.',
        'The agent silently substituted a different string and pretended that was the requested change.',
      ],
    },
    timeoutMs: 45_000,
  },
];
