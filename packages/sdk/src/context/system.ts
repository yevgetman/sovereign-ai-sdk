// Runtime/system context captured once when a session starts. The resulting
// text is frozen into the session prompt and reused on resume.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { arch, platform, release } from 'node:os';

export type SystemContextOptions = {
  cwd?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export type SystemContext = {
  os: string;
  shell: string;
  cwd: string;
  date: string;
  gitStatus: string;
  gitRecentCommits: string;
  gitRecentBranches: string;
};

export function getSystemContext(options: SystemContextOptions = {}): SystemContext {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  return {
    os: `${platform()} ${release()} (${arch()})`,
    shell: env.SHELL ?? '(unknown)',
    cwd,
    date: now.toISOString(),
    gitStatus: runGit(cwd, ['status', '-sb']),
    gitRecentCommits: runGit(cwd, ['log', '--oneline', '-5']),
    gitRecentBranches: runGit(cwd, [
      'branch',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      '--count=5',
    ]),
  };
}

export function formatSystemContext(context: SystemContext): string {
  return [
    '<runtime-context>',
    `date: ${context.date}`,
    `os: ${context.os}`,
    `shell: ${context.shell}`,
    `cwd: ${context.cwd.replace(homedir(), '~')}`,
    '',
    'git status:',
    indent(context.gitStatus),
    '',
    'recent commits:',
    indent(context.gitRecentCommits),
    '',
    'recent branches:',
    indent(context.gitRecentBranches),
    '</runtime-context>',
  ].join('\n');
}

function runGit(cwd: string, args: string[]): string {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 1_500,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output || '(none)';
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `(unavailable: ${message})`;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
