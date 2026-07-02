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

// Unconditionally read-only git subcommands. `config`, `stash`, `branch`,
// `tag` and `remote` are NOT here: each is dual-mode (reads OR mutates
// depending on args) and is classified arg-aware in analyzeGitCommand,
// defaulting to a prompt. (audit F2)
const GIT_READ_SUBCOMMANDS = new Set([
  'log',
  'status',
  'diff',
  'show',
  'blame',
  'shortlog',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'describe',
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

/** `find` primaries that execute commands or mutate the filesystem. Their
 *  presence demotes `find` from read to exec (audit C3). */
const FIND_DESTRUCTIVE_PRIMARIES = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fprint0',
  '-fls',
]);

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

  // `date` prints the clock (read) UNLESS it SETS the system clock via
  // `-s`/`--set`/`--set=…`, which is a privileged system-state write. Fail
  // closed to a prompt for the set form. (audit F24)
  if (cmd === 'date') {
    const setsClock = args.some((a) => a === '-s' || a === '--set' || a.startsWith('--set='));
    return setsClock
      ? { kind: 'exec', command: 'date' }
      : { kind: 'read', paths: extractPaths(args) };
  }

  if (cmd === 'git') {
    return analyzeGitCommand(args);
  }

  // `find` is a read tool ONLY without an action primary. `-delete` mutates;
  // `-exec`/`-execdir`/`-ok`/`-okdir` run an arbitrary command; `-fprint*`/`-fls`
  // write files. Any of these makes the segment non-read (audit C3).
  if (cmd === 'find' && args.some((a) => FIND_DESTRUCTIVE_PRIMARIES.has(a))) {
    return { kind: 'exec', command: 'find' };
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

// config sub-flags that always mutate (set/unset/edit config).
const GIT_CONFIG_WRITE_FLAGS = new Set([
  '--unset',
  '--unset-all',
  '--add',
  '--replace-all',
  '--edit',
  '-e',
  '--rename-section',
  '--remove-section',
]);

// config sub-flags that only read (get/list). A get takes at most one key
// positional; a list needs none.
const GIT_CONFIG_READ_FLAGS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '--list',
  '-l',
]);

// `git config` reads ONLY for pure gets: an explicit --get*/--list/-l, or a
// bare single-positional key (`git config user.name`) with no value token.
// Anything with a value arg or a mutating flag → write. config.pager/editor/
// sshCommand/alias.* are command-execution vectors, so default-deny. (F2)
function isGitConfigReadOnly(subArgs: string[]): boolean {
  if (subArgs.some((a) => GIT_CONFIG_WRITE_FLAGS.has(a))) return false;
  if (subArgs.some((a) => GIT_CONFIG_READ_FLAGS.has(a))) return true;
  const positionals = subArgs.filter((a) => !a.startsWith('-'));
  return positionals.length === 1;
}

// `git stash` reads ONLY for `list`/`show`. Bare `stash` and push/pop/apply/
// drop/clear/branch/store/create mutate the working tree or stash list. (F2)
const GIT_STASH_READ_SUBCOMMANDS = new Set(['list', 'show']);
function isGitStashReadOnly(subArgs: string[]): boolean {
  const first = subArgs.find((a) => !a.startsWith('-'));
  return first !== undefined && GIT_STASH_READ_SUBCOMMANDS.has(first);
}

// `git branch` sub-flags that create/delete/move/rename/rewire a branch.
const GIT_BRANCH_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '-f',
  '--force',
]);

// `git branch` reads ONLY as a pure list (bare, --list, -a/-r/-v). A positional
// name (create) or any mutating flag → write/prompt. (F2)
function isGitBranchReadOnly(subArgs: string[]): boolean {
  if (subArgs.some((a) => GIT_BRANCH_WRITE_FLAGS.has(a))) return false;
  const positionals = subArgs.filter((a) => !a.startsWith('-'));
  return positionals.length === 0;
}

// `git tag` sub-flags that create/delete/sign/force a tag.
const GIT_TAG_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-a',
  '--annotate',
  '-s',
  '--sign',
  '-m',
  '--message',
  '-F',
  '--file',
  '-f',
  '--force',
  '--create-reflog',
]);

// `git tag` reads ONLY as a list (-l/--list, or bare with no tag-name
// positional). Create/delete → write/prompt. (F2)
function isGitTagReadOnly(subArgs: string[]): boolean {
  if (subArgs.some((a) => GIT_TAG_WRITE_FLAGS.has(a))) return false;
  if (subArgs.some((a) => a === '-l' || a === '--list')) return true;
  const positionals = subArgs.filter((a) => !a.startsWith('-'));
  return positionals.length === 0;
}

// `git remote` reads ONLY when bare, `-v`/`--verbose`, or a `show`/`get-url`
// subcommand. add/remove/rm/set-url/set-head/set-branches/rename/prune/update
// → write/prompt. (F2)
const GIT_REMOTE_READ_SUBCOMMANDS = new Set(['show', 'get-url']);
function isGitRemoteReadOnly(subArgs: string[]): boolean {
  const first = subArgs.find((a) => !a.startsWith('-'));
  if (first === undefined) return true; // bare or only flags (e.g. -v)
  return GIT_REMOTE_READ_SUBCOMMANDS.has(first);
}

function analyzeGitCommand(args: string[]): VirtualOperation {
  const subIndex = args.findIndex((a) => !a.startsWith('-'));
  if (subIndex === -1) return { kind: 'read', paths: [] };
  const sub = args[subIndex] as string;
  const subArgs = args.slice(subIndex + 1);

  // Dual-mode subcommands: read only for explicit read forms, otherwise a
  // prompt (exec, not write) so a poisoned config value / ref mutation can
  // never resolve against a blanket `allow Read` OR `allow Write` rule. (F2)
  switch (sub) {
    case 'config':
      return isGitConfigReadOnly(subArgs)
        ? { kind: 'read', paths: [] }
        : { kind: 'exec', command: 'git config' };
    case 'stash':
      return isGitStashReadOnly(subArgs)
        ? { kind: 'read', paths: [] }
        : { kind: 'exec', command: 'git stash' };
    case 'branch':
      return isGitBranchReadOnly(subArgs)
        ? { kind: 'read', paths: [] }
        : { kind: 'exec', command: 'git branch' };
    case 'tag':
      return isGitTagReadOnly(subArgs)
        ? { kind: 'read', paths: [] }
        : { kind: 'exec', command: 'git tag' };
    case 'remote':
      return isGitRemoteReadOnly(subArgs)
        ? { kind: 'read', paths: [] }
        : { kind: 'exec', command: 'git remote' };
  }

  if (GIT_READ_SUBCOMMANDS.has(sub)) return { kind: 'read', paths: [] };
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) return { kind: 'write', paths: [] };
  return { kind: 'exec', command: `git ${sub}` };
}

export type SplitShellSegmentsOptions = {
  /** Break on a single `|` pipe too. Default true — a pipeline's every stage is
   *  its own operation for read-only analysis. Set false where a pipe should
   *  stay inside one segment (Bash(pattern) rule matching keeps its historical
   *  behavior of not splitting pipes). `||`, `&&`, `;`, newline and a control
   *  `&` are ALWAYS separators regardless. */
  splitPipes?: boolean;
};

/**
 * Split a shell command into top-level segments on control operators, honoring
 * single/double quotes and backslash escapes so a separator inside a quoted
 * string is not a boundary.
 *
 * Separators: `;`, newline (`\n`/`\r`), `&&`, `||`, a control `&`
 * (background/sequence), and — when `splitPipes` — a single `|`. A `&` that is
 * part of `&&`, a `&>file` redirect, or an fd-duplication (`2>&1`, `>&2`) is
 * NOT a separator. Missing newline + control-`&` here was an auth-bypass: a
 * read command followed by `\n`/`&` + a writer classified read-only (audit C2).
 */
export function splitShellSegments(command: string, opts?: SplitShellSegmentsOptions): string[] {
  const splitPipes = opts?.splitPipes ?? true;
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

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
      if (ch === ';' || ch === '\n' || ch === '\r') {
        flush();
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        flush();
        i++;
        continue;
      }
      if (ch === '&') {
        // Single `&`. A control operator (background / sequencing) UNLESS it is
        // part of a redirect: `&>file` (next char `>`) or an fd-duplication
        // such as `2>&1` / `>&2` (the char just appended to `current` was `>`).
        const next = command[i + 1];
        const prevNonSpace = current.replace(/\s+$/, '').slice(-1);
        if (next === '>' || prevNonSpace === '>') {
          current += ch;
          continue;
        }
        flush();
        continue;
      }
      if (ch === '|' && command[i + 1] === '|') {
        flush();
        i++;
        continue;
      }
      if (ch === '|' && splitPipes) {
        flush();
        continue;
      }
    }

    current += ch;
  }

  flush();
  return segments;
}

type TokenizeResult = {
  tokens: string[];
  redirectsToFile: boolean;
};

function tokenizeSegment(segment: string): TokenizeResult {
  const raw = segment.trim();
  let redirectsToFile = false;

  // Output redirect to a file: `> out`, `>>out` (no space — previously
  // slipped through and let `cat x >out` be classified read), `2> err`,
  // `&> all`. Fd-duplications (`2>&1`, `>&2`) target no file and are excluded.
  if (/(?:\d*|&)>>?\s*[^&\s]/.test(raw)) {
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
      const next = tokens[cursor];
      if (next === undefined) break;
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
