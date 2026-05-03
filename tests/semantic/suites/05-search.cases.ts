// Search-tool tests — Glob and Grep. The starter `01-tools` suite covers
// per-file Read/Edit/Write/Bash; these probe the search tools that handle
// "find files matching X" / "find content matching Y". Bug class targeted:
// the search tool is wired into the registry but doesn't actually fire,
// or fires but doesn't surface results into the response.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'glob-recursive-typescript-files',
    name: 'Agent finds .ts files across nested directories',
    description:
      'Guards against the search tool failing to recurse, or the agent enumerating only the top ' +
      'level (which would mimic `ls *.ts` and miss nested files). The setup hides one .ts file in ' +
      'src/sub/ specifically to catch non-recursive searches.',
    category: 'tools',
    setup: {
      files: [
        { path: 'src/main.ts', content: 'console.log("a");\n' },
        { path: 'src/util.ts', content: 'console.log("b");\n' },
        { path: 'src/sub/deep.ts', content: 'console.log("c");\n' },
        { path: 'src/foo.js', content: 'console.log("d");\n' },
        { path: 'README.md', content: '# Project\n' },
      ],
    },
    prompt:
      'Find all files ending in .ts in this directory and any subdirectories. List every match.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a search tool (Glob, Bash find, Grep, or equivalent) to enumerate .ts files.',
        "The agent's final response includes all three .ts files: src/main.ts, src/util.ts, and src/sub/deep.ts.",
      ],
      shouldNot: [
        "The agent's response includes src/foo.js or README.md as .ts matches.",
        'The agent missed src/sub/deep.ts (suggests a non-recursive search).',
        'The agent fabricated filenames that are not in the setup.',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'grep-finds-marker-content',
    name: 'Agent uses content search to locate a unique marker',
    description:
      'Guards against the agent guessing which file holds a string instead of grepping. The marker ' +
      'is unique enough that any plausible-sounding answer without a tool invocation is a fabrication.',
    category: 'tools',
    setup: {
      files: [
        { path: 'docs/intro.md', content: 'Welcome to the project.\n' },
        {
          path: 'docs/spec.md',
          content:
            'Some boilerplate.\nThe token is sovereign-grep-marker-9b2e and it is unique.\nMore boilerplate.\n',
        },
        { path: 'docs/notes.md', content: 'Other content here.\n' },
        { path: 'README.md', content: '# Project\n' },
      ],
    },
    prompt:
      'Search the docs/ directory for the string "sovereign-grep-marker-9b2e" and tell me which file contains it.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked a content-search tool (Grep, Bash grep, or equivalent) targeting the docs directory or its files.',
        "The agent's final response correctly identifies docs/spec.md as the file containing the marker.",
      ],
      shouldNot: [
        'The agent reported a different file than docs/spec.md.',
        'The agent claimed the marker was not found in any file.',
        'The agent answered without invoking a tool — that would be fabrication.',
      ],
    },
    timeoutMs: 60_000,
  },
];
