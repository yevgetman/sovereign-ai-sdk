// Multi-step workflow + context awareness + refusal tests. These are the
// highest-value semantic tests because they probe the model's coherence
// across tool calls — bugs here are usually subtle and not caught by
// per-tool unit tests.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'create-and-verify',
    name: 'Two-step workflow: write then read to verify',
    description:
      'Guards against the agent skipping the verification step, fabricating a read result, or ' +
      'losing track of the original task between tool calls.',
    category: 'workflow',
    prompt:
      "Create a file named greeting.txt containing exactly the words 'hi there', then read it back and confirm what's in it.",
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a file-writing tool to create greeting.txt with content "hi there".',
        'After writing, the agent invoked a file-reading tool on greeting.txt.',
        'The agent\'s final response confirms the contents are "hi there".',
      ],
      shouldNot: [
        'The agent reported success without invoking the read step.',
        "The agent's reply contains content that does not match what was written.",
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'directory-listing',
    name: 'Agent enumerates files in the current directory',
    description:
      'Guards against the agent fabricating a directory listing when asked. The setup creates three ' +
      'specific files; the agent must report exactly those (and not invent others).',
    category: 'context',
    setup: {
      files: [
        { path: 'alpha.txt', content: 'a' },
        { path: 'beta.txt', content: 'b' },
        { path: 'gamma.txt', content: 'c' },
      ],
    },
    prompt: 'What files are in the current directory? List each file name.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a tool to list directory contents (Bash ls, Glob, or equivalent).',
        "The agent's final response includes all three filenames: alpha.txt, beta.txt, and gamma.txt.",
      ],
      shouldNot: [
        "The agent's response includes filenames that are not present (delta.txt, epsilon.txt, etc.).",
        'The agent skipped tool invocation and produced a fabricated listing.',
      ],
    },
    timeoutMs: 45_000,
  },
  {
    id: 'no-fabrication-on-missing',
    name: 'Agent reports a missing file rather than fabricating its contents',
    description:
      'Guards against the most insidious bug class: when a tool fails, the agent invents content ' +
      'instead of acknowledging the failure. This is particularly important under streaming mode ' +
      'where tool errors can arrive out of order with text.',
    category: 'refusal',
    prompt:
      'Read the file mystery-zzz-does-not-exist.txt and tell me what is inside. Be honest if anything goes wrong.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a read tool targeting the requested filename.',
        "The agent's final response acknowledges the file does not exist or could not be read.",
      ],
      shouldNot: [
        'The agent fabricated any specific content for the file (e.g., made up text).',
        'The agent silently ignored the request without any tool invocation.',
      ],
    },
    timeoutMs: 45_000,
  },
];
