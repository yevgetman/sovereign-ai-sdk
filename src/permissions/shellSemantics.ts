// Shell command semantic analysis for permissions. Maps shell commands to
// virtual Read/Write/Edit operations so that read-only Bash calls can
// resolve against Read/Write permission rules rather than requiring
// explicit Bash(command) allow rules.
//
// Source of pattern: Qwen Code shell-semantics.ts (hand-written tokenizer,
// command → virtual-operation mapping, transparent prefix stripping).
// We start with ~60 commands; expand on demand.

export type VirtualOperation =
  | { kind: 'read'; paths: string[] }
  | { kind: 'write'; paths: string[] }
  | { kind: 'edit'; paths: string[] }
  | { kind: 'web'; urls: string[] }
  | { kind: 'exec'; command: string }
  | { kind: 'unsafe' };

const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'file',
  'wc',
  'stat',
  'md5sum',
  'sha256sum',
  'xxd',
  'od',
  'strings',
  'readlink',
  'realpath',
  'grep',
  'rg',
  'ag',
  'ack',
  'find',
  'fd',
  'locate',
  'which',
  'whereis',
  'type',
  'ls',
  'tree',
  'du',
  'df',
  'pwd',
  'dirs',
  'diff',
  'cmp',
  'comm',
  'echo',
  'printf',
  'true',
  'false',
  'date',
  'whoami',
  'hostname',
  'uname',
  'id',
  'env',
  'printenv',
]);

const WRITE_COMMANDS = new Set([
  'cp',
  'mv',
  'install',
  'dd',
  'touch',
  'mkdir',
  'mktemp',
  'tee',
  'ln',
]);

const EDIT_COMMANDS = new Set(['rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'truncate', 'shred']);

const WEB_COMMANDS = new Set(['curl', 'wget', 'fetch']);

const GIT_READ_SUBCOMMANDS = new Set([
  'log',
  'status',
  'diff',
  'show',
  'branch',
  'remote',
  'tag',
  'stash',
  'blame',
  'shortlog',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'describe',
  'config',
]);

const GIT_WRITE_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'push',
  'checkout',
  'reset',
  'merge',
  'rebase',
  'pull',
  'fetch',
  'cherry-pick',
  'revert',
  'clean',
  'init',
  'clone',
  'mv',
  'rm',
]);

const PATTERN_FIRST_COMMANDS = new Set(['grep', 'rg', 'ag', 'ack']);

const TRANSPARENT_PREFIXES = new Set([
  'sudo',
  'timeout',
  'env',
  'nice',
  'nohup',
  'command',
  'builtin',
  'exec',
  'time',
]);

const UNSAFE_PATTERNS = /\$\(|`|<\(|>\(/;

export function analyzeShellCommand(command: string): VirtualOperation[] {
  if (UNSAFE_PATTERNS.test(command)) return [{ kind: 'unsafe' }];

  const segments = splitShellSegments(command);
  if (segments.length === 0) return [{ kind: 'unsafe' }];

  const ops: VirtualOperation[] = [];
  for (const segment of segments) {
    ops.push(analyzeSegment(segment));
  }
  return ops;
}

export function isShellCommandReadOnly(command: string): boolean {
  const ops = analyzeShellCommand(command);
  return ops.length > 0 && ops.every((op) => op.kind === 'read');
}

export function shellCommandVirtualToolName(command: string): string | null {
  const ops = analyzeShellCommand(command);
  if (ops.length === 0) return null;
  if (ops.every((op) => op.kind === 'read')) return 'Read';
  if (ops.some((op) => op.kind === 'edit' || op.kind === 'unsafe')) return null;
  if (ops.some((op) => op.kind === 'write')) return 'Write';
  if (ops.some((op) => op.kind === 'web')) return null;
  return null;
}

function analyzeSegment(segment: string): VirtualOperation {
  const { tokens, redirectsToFile } = tokenizeSegment(segment);
  if (tokens.length === 0) return { kind: 'unsafe' };

  const { command: cmd, args } = extractCommand(tokens);
  if (!cmd) return { kind: 'unsafe' };

  if (redirectsToFile) {
    return { kind: 'write', paths: extractPaths(args) };
  }

  if (cmd === 'sed') {
    return args.includes('-i')
      ? { kind: 'edit', paths: extractPaths(args) }
      : { kind: 'read', paths: extractPaths(args) };
  }
  if (cmd === 'sort') {
    const oIdx = args.indexOf('-o');
    return oIdx !== -1
      ? { kind: 'edit', paths: extractPaths(args) }
      : { kind: 'read', paths: extractPaths(args) };
  }

  if (cmd === 'git') {
    return analyzeGitCommand(args);
  }

  if (READ_COMMANDS.has(cmd)) {
    const paths = PATTERN_FIRST_COMMANDS.has(cmd)
      ? extractPathsSkipFirst(args)
      : extractPaths(args);
    return { kind: 'read', paths };
  }
  if (WRITE_COMMANDS.has(cmd)) return { kind: 'write', paths: extractPaths(args) };
  if (EDIT_COMMANDS.has(cmd)) return { kind: 'edit', paths: extractPaths(args) };
  if (WEB_COMMANDS.has(cmd)) return { kind: 'web', urls: extractUrls(args) };

  return { kind: 'exec', command: cmd };
}

function analyzeGitCommand(args: string[]): VirtualOperation {
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub) return { kind: 'read', paths: [] };
  if (GIT_READ_SUBCOMMANDS.has(sub)) return { kind: 'read', paths: [] };
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) return { kind: 'write', paths: [] };
  return { kind: 'exec', command: `git ${sub}` };
}

export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === ';') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === '|' && command[i + 1] === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

type TokenizeResult = {
  tokens: string[];
  redirectsToFile: boolean;
};

function tokenizeSegment(segment: string): TokenizeResult {
  const raw = segment.trim();
  let redirectsToFile = false;

  if (/(?:^|[^2])>>?\s/.test(raw) || /&>\s/.test(raw)) {
    redirectsToFile = true;
  }

  const cleaned = raw
    .replace(/\d*>>?\s*\S+/g, ' ')
    .replace(/&>\s*\S+/g, ' ')
    .replace(/<\s*\S+/g, ' ');

  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of cleaned) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  return { tokens, redirectsToFile };
}

function extractCommand(tokens: string[]): { command: string | null; args: string[] } {
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
    cursor++;
  }

  let cmd = tokens[cursor] ?? null;
  const rest = tokens.slice(cursor + 1);

  if (cmd && TRANSPARENT_PREFIXES.has(cmd)) {
    while (cursor + 1 < tokens.length) {
      cursor++;
      const next = tokens[cursor]!;
      if (next.startsWith('-')) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) continue;
      if (TRANSPARENT_PREFIXES.has(next)) continue;
      if (/^\d+$/.test(next)) continue;
      cmd = next;
      return { command: cmd, args: tokens.slice(cursor + 1) };
    }
    return { command: null, args: [] };
  }

  if (cmd?.includes('/')) {
    const basename = cmd.split('/').pop() ?? '';
    if (
      READ_COMMANDS.has(basename) ||
      WRITE_COMMANDS.has(basename) ||
      EDIT_COMMANDS.has(basename) ||
      WEB_COMMANDS.has(basename)
    ) {
      cmd = basename;
    }
  }

  return { command: cmd, args: rest };
}

const FLAGS_WITH_VALUE = new Set([
  '-n',
  '-c',
  '-m',
  '-A',
  '-B',
  '-C',
  '-e',
  '-f',
  '-o',
  '-d',
  '-t',
  '-k',
  '-w',
  '-I',
  '-L',
  '-s',
  '-p',
  '-b',
  '-i',
  '--lines',
  '--count',
  '--max-count',
  '--after-context',
  '--before-context',
  '--context',
  '--regexp',
  '--file',
  '--output',
  '--delimiter',
  '--separator',
  '--key',
  '--width',
  '--include',
  '--exclude',
  '--depth',
  '--max-depth',
  '--min-depth',
  '--type',
  '--color',
]);

function extractPaths(args: string[]): string[] {
  const paths: string[] = [];
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(a)) skipNext = true;
      continue;
    }
    if (a.includes('=')) continue;
    if (/^\d+$/.test(a)) continue;
    paths.push(a);
  }
  return paths;
}

function extractPathsSkipFirst(args: string[]): string[] {
  const all = extractPaths(args);
  return all.slice(1);
}

function extractUrls(args: string[]): string[] {
  return args.filter((a) => /^https?:\/\//.test(a));
}
