// BashTool tests. These run real bash subprocesses — kept minimal and
// fast so the test suite stays under a second.

import { describe, expect, test } from 'bun:test';
import {
  BashTool,
  detectPrivilegeEscalation,
  formatBashOutput,
  isBashError,
  isReadOnlyBashCommand,
  matchesBashPermissionPattern,
} from '@yevgetman/sov-sdk/tools/BashTool';

const ctx = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'test',
};

describe('BashTool', () => {
  test('echo captures stdout and exit_code 0', async () => {
    const result = await BashTool.call({ command: 'echo hello' }, ctx);
    expect(result.data.exit_code).toBe(0);
    expect(result.data.stdout.trim()).toBe('hello');
    expect(result.data.stderr).toBe('');
    expect(result.data.timed_out).toBe(false);
    expect(isBashError(result.data)).toBe(false);
  });

  test('non-zero exit is captured but does not throw', async () => {
    const result = await BashTool.call({ command: 'exit 3' }, ctx);
    expect(result.data.exit_code).toBe(3);
    expect(isBashError(result.data)).toBe(true);
  });

  test('stderr is captured', async () => {
    const result = await BashTool.call({ command: 'echo oops 1>&2' }, ctx);
    expect(result.data.stderr.trim()).toBe('oops');
    expect(result.data.exit_code).toBe(0);
  });

  test('expect_token matched on last stdout line', async () => {
    const result = await BashTool.call(
      {
        command: 'echo start; echo FRY_STATUS_TRANSITION=complete',
        expect_token: 'FRY_STATUS_TRANSITION=complete',
      },
      ctx,
    );
    expect(result.data.token_matched).toBe(true);
    expect(isBashError(result.data)).toBe(false);
  });

  test('expect_token missing is flagged as error', async () => {
    const result = await BashTool.call({ command: 'echo done', expect_token: 'NOT_THERE' }, ctx);
    expect(result.data.token_matched).toBe(false);
    expect(isBashError(result.data)).toBe(true);
  });

  test('timeout_ms aborts long-running commands', async () => {
    const result = await BashTool.call({ command: 'sleep 5', timeout_ms: 100 }, ctx);
    expect(result.data.timed_out).toBe(true);
    expect(isBashError(result.data)).toBe(true);
  });

  test('formatBashOutput includes exit code and stdout', async () => {
    const formatted = formatBashOutput({
      stdout: 'hello',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    });
    expect(formatted).toContain('exit_code: 0');
    expect(formatted).toContain('hello');
  });

  test('Phase 4: isReadOnly + isConcurrencySafe driven by allowlist; defaults still false for non-allowlisted', () => {
    // Allowlisted command — concurrency-safe.
    expect(BashTool.isReadOnly({ command: 'echo 1' })).toBe(true);
    expect(BashTool.isConcurrencySafe({ command: 'echo 1' })).toBe(true);
    // Off-allowlist — fail-closed to false.
    expect(BashTool.isReadOnly({ command: 'rm -rf /tmp/foo' })).toBe(false);
    expect(BashTool.isConcurrencySafe({ command: 'rm -rf /tmp/foo' })).toBe(false);
    expect(BashTool.isDestructive({ command: 'echo 1' })).toBe(false);
    expect(BashTool.shouldDefer).toBe(false);
  });

  test('checkPermissions allows read-only commands and asks for mutating commands', async () => {
    const readOnly = await BashTool.checkPermissions({ command: 'pwd && ls' }, ctx);
    expect(readOnly.behavior).toBe('allow');
    const mutating = await BashTool.checkPermissions({ command: 'printf x > file' }, ctx);
    expect(mutating.behavior).toBe('ask');
  });

  test('redirect-to-file on an allowlisted read command is NOT auto-allowed', async () => {
    // cat/echo are in BASH_READ_COMMANDS; without redirect detection these
    // would auto-allow a file write with no prompt (the fail-open bug).
    for (const command of [
      'cat /etc/passwd > /tmp/exfil',
      'echo pwned >> /tmp/persist',
      'echo x>/tmp/nospace', // no space after '>'
    ]) {
      const perm = await BashTool.checkPermissions({ command }, ctx);
      expect(perm.behavior).toBe('ask');
    }
  });

  test('Phase 4: renderResult formats the bash output and propagates is_error on non-zero exit', async () => {
    const ok = await BashTool.call({ command: 'echo hello' }, ctx);
    const okRendered = BashTool.renderResult?.(ok.data);
    expect(okRendered?.content).toContain('hello');
    expect(okRendered?.content).toContain('exit_code: 0');
    expect(okRendered?.isError).toBe(false);

    const fail = await BashTool.call({ command: 'exit 7' }, ctx);
    const failRendered = BashTool.renderResult?.(fail.data);
    expect(failRendered?.content).toContain('exit_code: 7');
    expect(failRendered?.isError).toBe(true);
  });
});

describe('isReadOnlyBashCommand', () => {
  test('single allowlisted commands are read-only', () => {
    for (const cmd of [
      'ls',
      'pwd',
      'cat /etc/hosts',
      'echo "hello world"',
      'find . -name "*.ts"',
    ]) {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    }
  });

  test('off-allowlist commands are not read-only', () => {
    for (const cmd of ['rm -rf foo', 'mv a b', 'cp x y', 'touch z', 'unknown_binary --flag']) {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    }
  });

  test('chains of read-only commands stay safe across | && || ;', () => {
    expect(isReadOnlyBashCommand('cat foo.txt | grep bar | wc -l')).toBe(true);
    expect(isReadOnlyBashCommand('ls && pwd')).toBe(true);
    expect(isReadOnlyBashCommand('ls; pwd; whoami')).toBe(true);
    expect(isReadOnlyBashCommand('ls || echo nothing')).toBe(true);
  });

  test('a single unsafe segment poisons the whole chain', () => {
    expect(isReadOnlyBashCommand('cat foo.txt | rm -rf /')).toBe(false);
    expect(isReadOnlyBashCommand('ls && touch newfile')).toBe(false);
  });

  test('command substitution is rejected outright (cannot inspect inner)', () => {
    expect(isReadOnlyBashCommand('echo $(rm -rf /)')).toBe(false);
    expect(isReadOnlyBashCommand('echo `rm -rf /`')).toBe(false);
    expect(isReadOnlyBashCommand('cat <(rm -rf /)')).toBe(false);
    expect(isReadOnlyBashCommand('cat >(rm -rf /)')).toBe(false);
  });

  test('output redirection to a file is a write, not read-only', () => {
    expect(isReadOnlyBashCommand('cat secret > /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('echo pwned >> /tmp/bashrc')).toBe(false);
    expect(isReadOnlyBashCommand('echo x >/tmp/y')).toBe(false); // no space after '>'
    expect(isReadOnlyBashCommand('cat foo 2> err.log')).toBe(false);
    // fd-duplication writes no file — stays read-only
    expect(isReadOnlyBashCommand('grep x file 2>&1')).toBe(true);
  });

  test('leading env-var assignment is skipped before resolving the real command', () => {
    expect(isReadOnlyBashCommand('LC_ALL=C grep foo bar.txt')).toBe(true);
    expect(isReadOnlyBashCommand('LC_ALL=C rm -rf /')).toBe(false);
  });

  test('path-prefixed binaries are conservatively rejected', () => {
    expect(isReadOnlyBashCommand('/usr/bin/cat foo.txt')).toBe(false);
    expect(isReadOnlyBashCommand('./script.sh')).toBe(false);
  });

  // Audit 2026-06-10 C2/C3 — the read-only classifier gates the no-prompt
  // auto-allow that the channel gateway's safe posture relies on. A smuggled
  // writer (newline / single & separator) or a command launcher (env/find)
  // must NOT classify read-only.
  test('newline is a hard separator — no smuggling a writer after a read (C2)', () => {
    expect(isReadOnlyBashCommand('cat README.md\nrm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('cat README.md\r\nrm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('ls\nwhoami')).toBe(true); // both read → still read
  });

  test('a single & (background/sequence) is a hard separator (C2)', () => {
    expect(isReadOnlyBashCommand('cat x & rm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('ls & pwd')).toBe(true); // both read → still read
  });

  test('fd-duplication is NOT a separator — stays read-only (regression guard)', () => {
    expect(isReadOnlyBashCommand('grep x file 2>&1')).toBe(true);
    expect(isReadOnlyBashCommand('cat a >&2')).toBe(true);
  });

  test('env launcher cannot smuggle an arbitrary command as read-only (C3)', () => {
    expect(isReadOnlyBashCommand('env bash -c "rm -rf /"')).toBe(false);
    expect(isReadOnlyBashCommand('env rm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('env LC_ALL=C grep foo bar')).toBe(true); // env→grep, read
  });

  test('find with a destructive primary is not read-only (C3)', () => {
    expect(isReadOnlyBashCommand('find . -delete')).toBe(false);
    expect(isReadOnlyBashCommand('find . -exec rm {} +')).toBe(false);
    expect(isReadOnlyBashCommand('find . -execdir rm {} +')).toBe(false);
    expect(isReadOnlyBashCommand('find . -name "*.ts"')).toBe(true); // benign find still read
  });

  // Post-2026-06-10 deep-dive #1 (CRITICAL) — the find-primary detector was
  // quote-naive: quoting a destructive primary put a quote char before the
  // dash, so the gate classified the command read-only and auto-allowed an
  // arbitrary file deletion / command execution with NO permission prompt.
  // Bash itself honors quoted find primaries, so these MUST stay non-read.
  test('find with a QUOTED destructive primary is not read-only (#1 RCE)', () => {
    // Single-quoted primaries.
    expect(isReadOnlyBashCommand("find /x '-delete'")).toBe(false);
    expect(isReadOnlyBashCommand("find . '-exec' rm {} ';'")).toBe(false);
    expect(isReadOnlyBashCommand("find . '-execdir' rm {} +")).toBe(false);
    // Double-quoted primaries.
    expect(isReadOnlyBashCommand('find /x "-delete"')).toBe(false);
    expect(isReadOnlyBashCommand('find . "-exec" rm {} ";"')).toBe(false);
    // The destructive primary in a non-first position (after the path).
    expect(isReadOnlyBashCommand("find /tmp/bt5 -type f '-exec' rm {} ';'")).toBe(false);
    // Unquoted destructive variants still classify non-read (no regression).
    expect(isReadOnlyBashCommand('find . -delete')).toBe(false);
    expect(isReadOnlyBashCommand('find . -ok rm {} ;')).toBe(false);
    expect(isReadOnlyBashCommand('find . -fls out.txt')).toBe(false);
    // A genuinely read-only find stays read (no false-positive prompt-spam).
    expect(isReadOnlyBashCommand("find . -name '*.ts'")).toBe(true);
    expect(isReadOnlyBashCommand('find . -type f -name "*.md"')).toBe(true);
  });

  // Polish-pass 2026-07-02 — the auto-allow GATE (isReadOnlyBashCommand) was a
  // SECOND classifier that only deferred `find` to the hardened analyzer; every
  // other allowlisted command trusted a bare `split(/\s+/)`. So a write/exec
  // flag or operand on rg/tree/date/hostname auto-approved with NO prompt even
  // though analyzeShellCommand (the audited path) correctly flagged it. The gate
  // now defers EVERY allowlisted command to the analyzer. These pin that the
  // gate and the analyzer agree.
  test('allowlisted read command with a write/exec flag is NOT read-only (gate↔analyzer parity)', () => {
    // rg --pre / --hostname-bin run an arbitrary command per file.
    expect(isReadOnlyBashCommand('rg --pre ./evil.sh pat file')).toBe(false);
    expect(isReadOnlyBashCommand('echo x | xargs rg --pre ./evil.sh x')).toBe(false);
    // tree -o / --output writes/truncates a file.
    expect(isReadOnlyBashCommand('tree -o /tmp/victim.txt .')).toBe(false);
    // date / hostname set-forms mutate system state.
    expect(isReadOnlyBashCommand('date 010203042020')).toBe(false);
    expect(isReadOnlyBashCommand('hostname evilname')).toBe(false);
    // [N]>&FILE points stdout+stderr at a file (truncate) — the gate's own
    // segment regex missed this; the analyzer catches it.
    expect(isReadOnlyBashCommand('cat x >&out')).toBe(false);
    expect(isReadOnlyBashCommand('cat x 1>&out')).toBe(false);
    // No regression: the benign read forms of the same commands stay read-only.
    expect(isReadOnlyBashCommand('rg pattern file')).toBe(true);
    expect(isReadOnlyBashCommand('tree .')).toBe(true);
    expect(isReadOnlyBashCommand('date')).toBe(true);
    expect(isReadOnlyBashCommand('hostname')).toBe(true);
    expect(isReadOnlyBashCommand('cat x >&2')).toBe(true); // genuine fd-dup
  });

  // Polish-pass 2026-07-02 (CRITICAL) — ANSI-C `$'…'` quoting escapes
  // backslashes, so `$'\''` is a literal quote that does NOT close the quote.
  // The quote tracker in splitShellSegments treated it as POSIX `'…'` and ended
  // "inside a quote", swallowing every following separator: `cat $'\'';touch X`
  // collapsed into ONE segment classified read-only by its `cat` head, smuggling
  // an arbitrary command past the gate with no prompt. Bash runs `touch X`.
  test("ANSI-C $'…' quoting cannot smuggle a command past the read-only gate (RCE)", () => {
    expect(isReadOnlyBashCommand("cat $'\\'';touch OWNED")).toBe(false);
    expect(isReadOnlyBashCommand("cat $'\\'';rm -rf /tmp/x")).toBe(false);
    expect(isReadOnlyBashCommand("ls $'\\'' && touch OWNED")).toBe(false);
    // A genuine ANSI-C arg to a read command with no smuggled writer stays read.
    expect(isReadOnlyBashCommand("grep $'\\t' file")).toBe(true);
  });
});

describe('matchesBashPermissionPattern', () => {
  test('matches every command segment against token-bounded wildcard patterns', () => {
    expect(matchesBashPermissionPattern('git status', 'git *')).toBe(true);
    expect(matchesBashPermissionPattern('git status && git diff', 'git *')).toBe(true);
    expect(matchesBashPermissionPattern('git push --force', 'git *')).toBe(false);
  });

  test('skips leading env assignments and rejects command substitution', () => {
    expect(matchesBashPermissionPattern('LC_ALL=C grep foo file.txt', 'grep * *')).toBe(true);
    expect(matchesBashPermissionPattern('echo $(rm -rf /)', 'echo *')).toBe(false);
  });

  // Audit 2026-06-10 C2 — a smuggled command after a newline / control-& must
  // not be auto-allowed by a Bash(pattern) rule that only covers the prefix.
  test('newline / control-& smuggled command is not covered by a prefix pattern', () => {
    expect(matchesBashPermissionPattern('git status\nrm -rf /', 'git *')).toBe(false);
    expect(matchesBashPermissionPattern('git status & rm -rf /', 'git *')).toBe(false);
  });
});

describe('detectPrivilegeEscalation', () => {
  test('flags top-level sudo', () => {
    expect(detectPrivilegeEscalation('sudo grep foo /etc/cron*')).toBe('sudo');
  });

  test('flags sudo with flags', () => {
    expect(detectPrivilegeEscalation('sudo -E -H ls')).toBe('sudo');
  });

  test('flags pkexec / doas / su', () => {
    expect(detectPrivilegeEscalation('pkexec ls')).toBe('pkexec');
    expect(detectPrivilegeEscalation('doas ls')).toBe('doas');
    expect(detectPrivilegeEscalation('su -c "ls"')).toBe('su');
  });

  test('flags absolute-path invocations', () => {
    expect(detectPrivilegeEscalation('/usr/bin/sudo ls')).toBe('sudo');
  });

  test('flags sudo inside a pipeline', () => {
    expect(detectPrivilegeEscalation('cat foo.txt | sudo tee /etc/bar')).toBe('sudo');
  });

  test('flags sudo on the rhs of && / ||', () => {
    expect(detectPrivilegeEscalation('echo ok && sudo ls')).toBe('sudo');
    expect(detectPrivilegeEscalation('false || sudo ls')).toBe('sudo');
  });

  test('flags sudo after env-var assignment', () => {
    expect(detectPrivilegeEscalation('LC_ALL=C sudo grep foo /etc/passwd')).toBe('sudo');
  });

  // Audit 2026-06-10 C2 — sudo smuggled past the read classifier via newline /
  // control-& would otherwise hang on the TTY prompt (and evade the guard).
  test('flags sudo after a newline / control-& separator', () => {
    expect(detectPrivilegeEscalation('cat a\nsudo rm -rf /')).toBe('sudo');
    expect(detectPrivilegeEscalation('ls & sudo reboot')).toBe('sudo');
  });

  test('flags sudo behind an env launcher', () => {
    expect(detectPrivilegeEscalation('env sudo rm')).toBe('sudo');
  });

  test('returns null for benign commands containing the substring "sudo"', () => {
    expect(detectPrivilegeEscalation('echo sudo')).toBeNull();
    expect(detectPrivilegeEscalation('cat /etc/sudoers.d/foo')).toBeNull();
    expect(detectPrivilegeEscalation('grep sudo /var/log/auth.log')).toBeNull();
  });

  test('returns null for empty / whitespace input', () => {
    expect(detectPrivilegeEscalation('')).toBeNull();
    expect(detectPrivilegeEscalation('   ')).toBeNull();
  });

  // Post-2026-06-10 deep-dive #24 — the escalator scan tokenized on whitespace
  // WITHOUT stripping quotes, so a quoted escalator ("'sudo' rm -rf /") was the
  // literal token "'sudo'" which !== 'sudo' after basename strip → evaded the
  // hang-guard. Same quote-naive root cause as #1; fix consistently.
  test('flags a QUOTED escalator (#24)', () => {
    expect(detectPrivilegeEscalation("'sudo' rm -rf /")).toBe('sudo');
    expect(detectPrivilegeEscalation('"sudo" ls')).toBe('sudo');
    expect(detectPrivilegeEscalation("'pkexec' ls")).toBe('pkexec');
    expect(detectPrivilegeEscalation("echo ok && 'sudo' ls")).toBe('sudo');
    expect(detectPrivilegeEscalation("'/usr/bin/sudo' ls")).toBe('sudo');
  });
});

describe('BashTool sudo guardrail', () => {
  test('refuses sudo without spawning bash; surfaces explanation', async () => {
    const result = await BashTool.call({ command: 'sudo ls /etc' }, ctx);
    expect(result.data.exit_code).toBe(126);
    expect(result.data.stdout).toBe('');
    expect(result.data.stderr).toContain('Refused');
    expect(result.data.stderr).toContain('sudo');
    expect(result.data.stderr).toContain('run the command yourself');
    expect(result.data.stderr).toContain('sudo ls /etc');
    expect(isBashError(result.data)).toBe(true);
  });

  test('refusal happens fast (no bash spawn, no timeout wait)', async () => {
    const start = performance.now();
    const result = await BashTool.call({ command: 'sudo ls /etc' }, ctx);
    const elapsed = performance.now() - start;
    expect(result.data.exit_code).toBe(126);
    expect(elapsed).toBeLessThan(50);
  });

  test('non-sudo commands continue to run normally', async () => {
    const result = await BashTool.call({ command: 'echo not-sudo' }, ctx);
    expect(result.data.exit_code).toBe(0);
    expect(result.data.stdout.trim()).toBe('not-sudo');
  });
});

describe('BashTool — observation envelope (Phase 12.5)', () => {
  test('success path emits status: success with stdout summary', async () => {
    const result = await BashTool.call({ command: 'echo hello-bash-12-5' }, ctx);
    expect(result.observation?.status).toBe('success');
    expect(result.observation?.summary).toBe('hello-bash-12-5');
    expect(result.observation?.next_actions).toBeUndefined();
  });

  test('non-zero exit emits status: error with stderr summary', async () => {
    const result = await BashTool.call({ command: 'echo oops 1>&2; exit 3' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('exit 3');
    expect(result.observation?.summary).toContain('oops');
  });

  test('command-not-found suggests installing the binary', async () => {
    const result = await BashTool.call({ command: 'definitely-not-a-real-binary-zz4' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('install')]),
    );
  });

  test('timeout emits a timeout-specific envelope', async () => {
    const result = await BashTool.call({ command: 'sleep 5', timeout_ms: 50 }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('timed out');
    expect(result.observation?.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('timeout_ms')]),
    );
  });

  test('expect_token miss surfaces a token-specific envelope', async () => {
    const result = await BashTool.call({ command: 'echo done', expect_token: 'NOT_THERE' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('expect_token');
  });

  test('privilege-escalation refusal surfaces in the envelope', async () => {
    const result = await BashTool.call({ command: 'sudo ls /etc' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.observation?.summary).toContain('sudo');
    expect(result.observation?.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('run the command yourself')]),
    );
  });
});
