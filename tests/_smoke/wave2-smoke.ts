// Wave-2 visual smoke test. Renders the new slash-command output
// surfaces (no picker — pickers need a TTY and are exercised via
// the live REPL). Run with: bun run tests/_smoke/wave2-smoke.ts

import type { Skill } from '@yevgetman/sov-sdk/skills/types';
import chalk from 'chalk';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { makeCtx } from '../commands/_makeCtx.js';

const fakeSkill = (name: string, description: string, source: Skill['source']): Skill => ({
  name,
  description,
  whenToUse: '',
  allowedTools: [],
  path: `/tmp/${name}.md`,
  realpath: `/tmp/${name}.md`,
  dir: '/tmp',
  source,
  trustTier: 'trusted',
  allowShellInterpolation: source !== 'plugin',
  metadata: {
    harness: {
      requiresToolsets: [],
      requiresTools: [],
      fallbackForToolsets: [],
      fallbackForTools: [],
    },
  },
  guard: { action: 'allow', findings: [] },
  body: '',
});

async function show(label: string, command: string, ctx = makeCtx()): Promise<void> {
  console.log(`\n${chalk.bold.cyan('───')} ${chalk.bold(label)} ${chalk.bold.cyan('───')}\n`);
  const result = await dispatchSlashCommand(command, ctx);
  if (result.kind === 'local') {
    console.log(result.output);
  } else if (result.kind === 'prompt') {
    console.log(chalk.gray('[prompt command — would submit to model]'));
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    console.log(chalk.gray(text.split('\n').slice(0, 6).join('\n')));
    console.log(chalk.dim(`  ... allowedTools: ${result.command.allowedTools?.join(', ')}`));
  } else {
    console.log(result.output);
  }
}

await show('/help (categorized 2-column layout)', '/help');

await show('/about (project info card)', '/about');

await show(
  '/skills (with sample skills)',
  '/skills',
  makeCtx({
    skills: {
      skills: [
        fakeSkill('simplify', 'Review code for reuse and quality', 'project'),
        fakeSkill('init', 'Initialize project context', 'user'),
      ],
      byName: new Map([
        ['simplify', fakeSkill('simplify', 'Review code for reuse and quality', 'project')],
        ['init', fakeSkill('init', 'Initialize project context', 'user')],
      ]),
    },
  }),
);

await show(
  '/permissions (mode + persistent + always-allow)',
  '/permissions',
  makeCtx({
    getPermissions: () => ({
      mode: 'ask',
      alwaysAllow: ['Bash(git status)', 'Read(src/**)'],
      layers: [
        {
          source: 'project:.harness/settings.local.json',
          rules: [
            { behavior: 'allow', tool: 'Bash', content: 'git status', raw: 'Bash(git status)' },
            { behavior: 'deny', tool: 'Bash', content: 'rm -rf *', raw: 'Bash(rm -rf *)' },
          ],
        },
      ],
    }),
  }),
);

await show('/stats (mid-session summary card)', '/stats');

await show('/init (prompt command)', '/init');

await show('/export (no messages → graceful)', '/export md');
