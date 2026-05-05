// Skill invocation tests. Skills are markdown files with frontmatter
// loaded from <cwd>/.harness/skills/, <HARNESS_HOME>/skills/, and bundle
// paths. Each loaded skill registers as a slash command — typing
// /<skill-name> dispatches a model turn with the skill's body as the
// prompt, scoped to its allowedTools.
//
// Bug class targeted: skill loader pipeline regression (skill files not
// discovered, frontmatter parse failures, registry not picking up skills,
// or slash-command dispatch failing for skill-sourced commands).

import type { SemanticTest } from '../framework/types.js';

const SKILL_BODY = [
  '---',
  'name: marker-skill',
  'description: Test skill that prints a unique marker token',
  'allowedTools: []',
  'whenToUse: Invoked by the semantic test suite to verify skill loading',
  '---',
  '',
  'Please reply with the exact phrase "skill-invocation-token-7zk9aqx" so the test',
  'can verify you ran. Do not use any tools — just reply with the phrase.',
  '',
].join('\n');

// Skill body with NO {{args}} placeholder. The skill loader must still
// surface the user-supplied slash arguments to the model — otherwise
// `/echo-args <something>` silently drops the something. Mirrors the
// real `/review ~/path` regression where the user's path was discarded.
const ECHO_ARGS_SKILL_BODY = [
  '---',
  'name: echo-args',
  'description: Test skill that proves slash arguments reach the model',
  'allowedTools: []',
  'whenToUse: Invoked by the semantic test suite to verify arg propagation',
  '---',
  '',
  'Reply with one line in this exact format: "echoed: <ARGS>" where <ARGS>',
  'is whatever the user supplied as slash-command arguments. Do not invoke',
  'any tools. If you received no arguments, reply with "echoed: (none)".',
  '',
].join('\n');

export const tests: SemanticTest[] = [
  {
    id: 'skill-invocation-via-slash-command',
    name: 'A markdown skill in .harness/skills/ registers as a slash command and runs',
    description:
      'Verifies the full skill pipeline end-to-end: loader discovers the markdown file in ' +
      '<cwd>/.harness/skills/, parses its frontmatter, registers it as a slash command, and the ' +
      'command dispatches a model turn with the skill body as the prompt. Bug class: any link in ' +
      'this chain breaking silently (file ignored, frontmatter parse fail, registry miss, dispatch ' +
      'miss).',
    category: 'commands',
    setup: {
      files: [
        {
          path: '.harness/skills/marker-skill.md',
          content: SKILL_BODY,
        },
      ],
    },
    prompt: '/marker-skill',
    judgeCriteria: {
      mustSatisfy: [
        'The transcript shows /marker-skill being recognized as a valid slash command (not "unknown command").',
        'A model turn was dispatched in response to the slash command.',
        'The agent\'s final response includes the literal token "skill-invocation-token-7zk9aqx" — proving the skill body was used as the prompt and the model executed it.',
      ],
      shouldNot: [
        'The transcript reports /marker-skill as an unknown or unrecognized command.',
        'The agent invoked any tools (the skill body explicitly says no tools are needed).',
        'The agent fabricated a different token instead of the literal one in the skill body.',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'skill-args-propagate-to-prompt',
    name: 'Slash-command arguments reach the model even when the skill body has no {{args}} placeholder',
    description:
      'Regression guard for the bug where `/review ~/code/babyboard/` lost the path because the ' +
      'review skill did not include a {{args}} placeholder. The loader must append user arguments ' +
      'as a fallback so the model still sees what the user typed. Bug class: silent argument drop ' +
      'in any prompt-style slash command (skill or built-in).',
    category: 'commands',
    setup: {
      files: [
        {
          path: '.harness/skills/echo-args.md',
          content: ECHO_ARGS_SKILL_BODY,
        },
      ],
    },
    prompt: '/echo-args sovereign-args-token-9pq3xn',
    judgeCriteria: {
      mustSatisfy: [
        'The transcript shows /echo-args being recognized as a valid slash command (not "unknown command").',
        "The agent's final response contains the literal token 'sovereign-args-token-9pq3xn' — proving the user-supplied slash arguments reached the model even though the skill body had no {{args}} placeholder.",
      ],
      shouldNot: [
        'The transcript reports /echo-args as an unknown or unrecognized command.',
        'The agent replied with "echoed: (none)" — that would mean the arguments were silently dropped.',
        'The agent invoked any tools (the skill body explicitly says no tools are needed).',
      ],
    },
    timeoutMs: 60_000,
  },
];
