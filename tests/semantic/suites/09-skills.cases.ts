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
];
