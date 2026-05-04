// Inline shell — the `!` prefix at the user prompt. Runs the rest of the
// line as a bash command with stdio inherited from the harness, so the
// command has a live TTY: password prompts, interactive editors, color
// output, paging — everything works as if the user typed it in their
// regular shell.
//
// Why TTY inheritance: this is the explicit escape hatch for the cases
// BashTool can't handle (sudo / TouchID / pagers / interactive prompts).
// The trade-off is we don't capture the output for the agent — by design.
// The user types `! foo` to do something for themselves, not to feed
// state to the conversation.
//
// SIGINT handling: while a `!` command is running, the REPL temporarily
// installs a no-op SIGINT handler. With stdio inherited, the child shares
// the controlling terminal and receives Ctrl-C directly; the no-op handler
// keeps the REPL itself from exiting on the same signal.

export type InlineShellResult = {
  exitCode: number;
  /** True when the command was empty (just `!` or `!  `) — caller should
   *  print a usage hint and not record anything. */
  empty: boolean;
};

export type InlineShellOpts = {
  /** Override stdio. Defaults to 'inherit' (live TTY). Tests pass 'pipe'
   *  so they don't take over the test runner's terminal. */
  stdio?: 'inherit' | 'pipe';
  cwd?: string;
};

const SHELL_BIN = '/bin/bash';

export async function runInlineShell(
  rawInput: string,
  opts: InlineShellOpts = {},
): Promise<InlineShellResult> {
  const command = stripPrefix(rawInput);
  if (command.length === 0) {
    return { exitCode: 0, empty: true };
  }

  const stdio = opts.stdio ?? 'inherit';

  const prevSigint = process.listeners('SIGINT');
  const swallow = () => {
    // Child receives the signal directly (same TTY). REPL stays alive.
  };
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', swallow);

  try {
    const proc = Bun.spawn([SHELL_BIN, '-c', command], {
      stdin: stdio,
      stdout: stdio,
      stderr: stdio,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const exitCode = await proc.exited;
    return { exitCode, empty: false };
  } finally {
    process.removeListener('SIGINT', swallow);
    for (const l of prevSigint) {
      process.on('SIGINT', l as NodeJS.SignalsListener);
    }
  }
}

/** Strip the leading `!` and any whitespace that follows it. */
export function stripPrefix(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('!')) return trimmed.trim();
  return trimmed.slice(1).trim();
}

/** True when the trimmed input begins with `!` and is meant for inline shell.
 *  Callers should match on this BEFORE checking for slash commands so a hostile
 *  filename or skill name can never shadow the prefix. */
export function isInlineShellInput(trimmed: string): boolean {
  return trimmed.startsWith('!');
}
