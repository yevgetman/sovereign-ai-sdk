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

// ---------------------------------------------------------------------------
// Flag-family matching (attached-suffix / long / long=value / cluster forms)
// ---------------------------------------------------------------------------
// A write-capable flag rarely appears only as its bare short token. The same
// capability is reachable as an attached short suffix (`-i.bak`, `-oFILE`), a
// long flag (`--in-place`, `--output`), a long flag with an inline value
// (`--in-place=.bak`, `--output=out`), or bundled inside a short cluster
// (`-ni`, `-uoFILE`). An exact-token check (`args.includes('-i')`,
// `args.indexOf('-o')`) sees ONLY the bare short form and silently classifies
// every other form read — a permission-RELAXATION vulnerability, since a
// destructive in-place edit / file overwrite then resolves against `allow Read`
// with no prompt. This matcher recognizes the whole family so each handler can
// fail closed (edit/write/exec) on ANY member. It is the sibling of the git D6
// fix (41af0e8), which rebuilt git flag parsing for exactly this attached-value
// class but left sed/sort/date/fd/tree on the naive exact-token check. (audit
// C3/C4)
type FlagFamily = {
  /** Long flag names, e.g. `--in-place`. Matches the exact token AND the
   *  `--name=value` inline-value form. A space-separated value (`--output f`)
   *  is a separate positional token — the flag token itself still matches. */
  long: string[];
  /** Option characters, e.g. 'i' (sed) or 'xX' (fd, either). Each character is a
   *  family member; the attached form `-i.bak` is the char at position 0 of the
   *  short cluster followed by its value. */
  short?: string;
  /** Also match a member character ANYWHERE inside a bundled short cluster
   *  (`-ni`, `-uoFILE`), not just position 0. Enable ONLY when the character is
   *  unambiguous for the command — no other short flag takes a value that could
   *  contain it. Safe for sed `-i` (in-place is `i`'s sole meaning) and sort/fd
   *  `-o`/`-x`; NOT safe for date `-s` (`-Iseconds` carries an 's' in `-I`'s
   *  value), so date is left position-0. Fail-closed direction: enabling this
   *  can only over-prompt a contrived value collision, never miss a write. */
  shortInCluster?: boolean;
};

// Does a single token belong to a flag family, in any of its attached/long/
// cluster forms? Non-flag tokens (positionals) never match.
function matchesFlagFamily(token: string, family: FlagFamily): boolean {
  if (!token.startsWith('-')) return false;
  if (token.startsWith('--')) {
    const name = token.split('=')[0] as string;
    return family.long.includes(name);
  }
  const short = family.short;
  if (short === undefined) return false;
  const chars = token.slice(1);
  if (chars.length === 0) return false;
  if (family.shortInCluster) {
    for (const ch of chars) {
      if (short.includes(ch)) return true;
    }
    return false;
  }
  return short.includes(chars.charAt(0));
}

// `sed` edits IN PLACE for `-i`/`-i.bak`/`-iSUFFIX` (BSD/macOS attach the
// suffix) and GNU `--in-place`/`--in-place=.bak`. `i` means only in-place, so
// any short cluster carrying it (`-ni`) edits too. (audit C3 — this SDK ships on
// darwin where `-i.bak`/`-i ''` is THE in-place idiom.)
const SED_INPLACE_FLAG: FlagFamily = { long: ['--in-place'], short: 'i', shortInCluster: true };

// `sort` writes (truncates) a file for `-o`/`-oFILE`, `--output`/`--output=FILE`
// or a space-separated `--output FILE`. `o` is unambiguous for sort, so a
// cluster (`-uoFILE`) writes too. (audit C4)
const SORT_OUTPUT_FLAG: FlagFamily = { long: ['--output'], short: 'o', shortInCluster: true };

// `date` SETS the clock for `-s`/`-sSTRING`, `--set`/`--set=STRING`. NOT
// cluster-matched: `-Iseconds` carries an 's' inside `-I`'s value. (audit F24/D12)
const DATE_SET_FLAG: FlagFamily = { long: ['--set'], short: 's' };

// `fd` runs an arbitrary command per/across results via `-x`/`--exec` and
// `-X`/`--exec-batch` — the same exec vector as `find -exec`, but `fd` was a
// plain read command with no such guard, so `fd -x rm {}` auto-approved under
// `allow Read`. Demote to exec (prompt). (audit C3-sibling: a read command with
// a writer/exec flag.)
const FD_EXEC_FLAG: FlagFamily = {
  long: ['--exec', '--exec-batch'],
  short: 'xX',
  shortInCluster: true,
};

// `tree` redirects its listing to a file with `-o FILE`/`-oFILE`/`--output FILE`/
// `--output=FILE`, overwriting it — while classified a plain read. Position-0
// only (`-o…`): tree's `-P`/`-I` pattern flags can carry an 'o' in their value.
// (audit C4-sibling.)
const TREE_OUTPUT_FLAG: FlagFamily = { long: ['--output'], short: 'o' };

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
    return args.some((a) => matchesFlagFamily(a, SED_INPLACE_FLAG))
      ? { kind: 'edit', paths: extractPaths(args) }
      : { kind: 'read', paths: extractPaths(args) };
  }
  if (cmd === 'sort') {
    return args.some((a) => matchesFlagFamily(a, SORT_OUTPUT_FLAG))
      ? { kind: 'edit', paths: extractPaths(args) }
      : { kind: 'read', paths: extractPaths(args) };
  }

  // `date` prints the clock (read) UNLESS it SETS the system clock: GNU
  // `-s`/`--set`/`--set=…`, OR the BSD/macOS positional form
  // `date [[[[[cc]yy]mm]dd]HH]MM[.ss]` (e.g. `date 010203042020`). A plain read
  // only ever takes a `+FORMAT` operand, so ANY bare non-flag, non-`+FORMAT`
  // positional is the BSD clock-set form. Fail closed to a prompt for either.
  // (audit F24 + D12: this SDK ships on darwin where the positional form works.)
  if (cmd === 'date') {
    const setsClock = args.some(
      (a) =>
        // GNU `-s`/`-sSTRING`/`--set`/`--set=STRING` (attached short included via
        // the family matcher), OR the BSD/macOS positional clock-set form.
        matchesFlagFamily(a, DATE_SET_FLAG) || (!a.startsWith('-') && !a.startsWith('+')),
    );
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

  // `fd` is find's modern sibling and a read tool ONLY without an exec primary.
  // `-x`/`--exec` (per-result) and `-X`/`--exec-batch` (all results) run an
  // arbitrary command, so they demote fd to exec like `find -exec`. (audit
  // C3-sibling — fd was a plain READ_COMMANDS member with no exec guard.)
  if (cmd === 'fd' && args.some((a) => matchesFlagFamily(a, FD_EXEC_FLAG))) {
    return { kind: 'exec', command: 'fd' };
  }

  // `tree` prints a listing (read) UNLESS `-o FILE`/`-oFILE`/`--output=FILE`
  // redirects it to a file, overwriting the target. (audit C4-sibling.)
  if (cmd === 'tree' && args.some((a) => matchesFlagFamily(a, TREE_OUTPUT_FLAG))) {
    return { kind: 'write', paths: extractPaths(args) };
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

// Normalize a flag token to its matchable NAME so an allow/deny set can match
// the attached-value forms git accepts: a long `--flag=value` → `--flag`, a
// short attached `-xVALUE` → `-x`. Bare flags pass through unchanged. Matching
// the raw token (e.g. `--set-upstream-to=origin/main`, `-uorigin/main`) against
// a Set of bare flag names silently misses these — the D6 defect. (audit F2/D6)
function normalizeFlag(a: string): string {
  if (a.startsWith('--')) return a.split('=')[0] as string;
  if (a.startsWith('-') && a.length > 2) return a.slice(0, 2);
  return a;
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

// config location/source flags that consume a following FILE/BLOB operand. That
// operand is a source selector, NOT a config value, so it must not count toward
// the value-positional tally that separates a get (`config key`) from a set
// (`config key value`). Not counting it is the D9 over-prompt fix.
const GIT_CONFIG_OPERAND_FLAGS = new Set(['-f', '--file', '--blob']);

// `git config` reads ONLY for pure gets: an explicit --get*/--list/-l, or a
// bare single-positional key (`git config user.name`) with no value token.
// Anything with a value arg or a mutating flag → write. config.pager/editor/
// sshCommand/alias.* are command-execution vectors, so default-deny. (F2)
function isGitConfigReadOnly(subArgs: string[]): boolean {
  if (subArgs.some((a) => GIT_CONFIG_WRITE_FLAGS.has(normalizeFlag(a)))) return false;
  if (subArgs.some((a) => GIT_CONFIG_READ_FLAGS.has(normalizeFlag(a)))) return true;

  // Count value-positionals, skipping the operand a space-separated -f/--file/
  // --blob consumes (`--file path key`). An attached `--file=path`/`-fpath`
  // carries its operand inline and consumes no positional token.
  const valuePositionals: string[] = [];
  let skipNext = false;
  for (const a of subArgs) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a.startsWith('-')) {
      const name = normalizeFlag(a);
      if (GIT_CONFIG_OPERAND_FLAGS.has(name) && a === name) skipNext = true;
      continue;
    }
    valuePositionals.push(a);
  }
  // A get names at most one key and no value; a second positional is the VALUE
  // of a set (write). (`git config --file f key value` is still a write.)
  return valuePositionals.length <= 1;
}

// `git stash` reads ONLY for `list`/`show`. Bare `stash` and push/pop/apply/
// drop/clear/branch/store/create mutate the working tree or stash list. (F2)
const GIT_STASH_READ_SUBCOMMANDS = new Set(['list', 'show']);
function isGitStashReadOnly(subArgs: string[]): boolean {
  const first = subArgs.find((a) => !a.startsWith('-'));
  return first !== undefined && GIT_STASH_READ_SUBCOMMANDS.has(first);
}

// `git branch` LIST/inspect flags — the ONLY forms that read. Everything else
// (create/delete/move/copy/upstream/force/track/edit-description) mutates a ref.
// Inverting to a read-flag WHITELIST (vs the old write-flag denylist) fails
// closed: attached-value forms (`--set-upstream-to=x`, `-uorigin/main`) and
// bundled short clusters can no longer smuggle a write past an exact-token
// denylist. Long value-taking read flags (`--contains`, `--sort`, `--format`,
// `--points-at`, `--merged`) are included so their attached `--flag=v` forms
// still read; a space-separated value becomes a positional → prompt (as it did
// pre-fix). (audit F2 + D6)
const GIT_BRANCH_READ_LONG_FLAGS = new Set([
  '--list',
  '--all',
  '--remotes',
  '--verbose',
  '--ignore-case',
  '--omit-empty',
  '--show-current',
  '--color',
  '--no-color',
  '--column',
  '--no-column',
  '--abbrev',
  '--no-abbrev',
  '--sort',
  '--format',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
]);
// Short list/inspect flags — all boolean (none take a value), so a short cluster
// reads only if EVERY char is one of these. `-u`/`-d`/`-D`/`-m`/… fall through
// to write. (F2/D6)
const GIT_BRANCH_READ_SHORT_FLAGS = new Set(['a', 'r', 'v', 'l', 'i']);

// `git branch` reads ONLY as a list: bare, or with recognized list flags, and
// at most a single glob/name PATTERN positional under --list/-l. A bare name
// positional (create) or any unrecognized flag → write/prompt (fail closed).
// (F2 + D6 attached-value flags + D9 restore of `--list <pattern>`)
function isGitBranchReadOnly(subArgs: string[]): boolean {
  let hasListFlag = false;
  for (const a of subArgs) {
    if (!a.startsWith('-')) continue; // positional — tallied below
    if (a.startsWith('--')) {
      const name = a.split('=')[0] as string;
      if (!GIT_BRANCH_READ_LONG_FLAGS.has(name)) return false; // fail closed
      if (name === '--list') hasListFlag = true;
    } else {
      for (const ch of a.slice(1)) {
        if (!GIT_BRANCH_READ_SHORT_FLAGS.has(ch)) return false; // fail closed
      }
      if (a.includes('l')) hasListFlag = true;
    }
  }
  const positionals = subArgs.filter((a) => !a.startsWith('-'));
  if (positionals.length === 0) return true;
  // A positional reads ONLY as a listing pattern under --list/-l; a bare
  // positional is a branch name (create) → write.
  return hasListFlag && positionals.length === 1;
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
// positional). Create/delete → write/prompt. The write-flag check is normalized
// so attached-value forms (`-mmsg`, `-Ffile`) still match the denylist. (F2/D6)
function isGitTagReadOnly(subArgs: string[]): boolean {
  if (subArgs.some((a) => GIT_TAG_WRITE_FLAGS.has(normalizeFlag(a)))) return false;
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

// The ALWAYS-READ subcommands (diff/log/show/shortlog/blame — the diff family)
// honor `--output=<file>` / `--output <file>`, which CREATES/TRUNCATES an
// arbitrary file: a write masquerading as a read. An always-read subcommand
// trusting every arg auto-approved `git diff --output=PRECIOUS.txt` under
// `allow Read` while clobbering the target (reproduced, git 2.50.1). The long
// matcher covers `--output` and its inline `--output=v`; a space-separated
// `--output f` still matches on the `--output` token itself. Fail closed to a
// prompt on ANY read subcommand carrying it. (round-4 E1 — sibling of the F2
// dual-mode fix, which left the always-read subcommands trusting every arg.)
const GIT_OUTPUT_FILE_FLAG: FlagFamily = { long: ['--output'] };

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

  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    // Even an always-read subcommand writes a file via the diff-pipeline
    // `--output=<file>` / `--output <file>` flag, so it is NOT read-only when
    // present. Fail closed to a prompt. (round-4 E1)
    if (subArgs.some((a) => matchesFlagFamily(a, GIT_OUTPUT_FILE_FLAG))) {
      return { kind: 'exec', command: `git ${sub}` };
    }
    return { kind: 'read', paths: [] };
  }
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
  //
  // The bash `[N]>&WORD` form is a SECOND file-redirect when WORD is a filename
  // (`>&out`, `1>&out`): it points BOTH stdout+stderr at that file
  // (truncate/create), exactly like `&>file`. The `[^&\s]` above excludes it as
  // if it were an fd-duplication, so a write masqueraded as a read and
  // auto-approved under `allow Read`, clobbering the target (audit G4). Treat
  // `[N]>&WORD` as a write when WORD is a filename; keep numeric operands
  // (`2>&1`, `>&2`) and the fd-close `>&-` as fd-dups (lookahead excludes a
  // following digit/`-`/whitespace).
  if (/(?:\d*|&)>>?\s*[^&\s]/.test(raw) || /\d*>&\s*(?![-\d\s])\S/.test(raw)) {
    redirectsToFile = true;
  }

  const cleaned = raw
    // Strip `[N]>&FILE` first so its filename operand is removed rather than
    // surfacing as a spurious positional path. Same fd-dup exclusion as above.
    .replace(/\d*>&\s*(?![-\d\s])\S+/g, ' ')
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
