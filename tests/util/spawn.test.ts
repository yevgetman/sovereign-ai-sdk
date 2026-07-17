// Cross-runtime spawn shim tests — run real subprocesses (bash/cat/pwd),
// kept minimal and fast (BashTool-test pattern). The `new Response(...)`
// reads are load-bearing: they prove stdout/stderr are genuine WEB streams
// (a Node Readable would fail there at runtime with no compile error).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KILLED_EXIT_CODE,
  SPAWN_FAILURE_EXIT_CODE,
  spawnProc,
} from '@yevgetman/sov-sdk/util/spawn';

describe('spawnProc', () => {
  test('captures stdout via Web-stream Response and resolves exit 0', async () => {
    const proc = spawnProc(['echo', 'hi'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout.trim()).toBe('hi');
    expect(exitCode).toBe(0);
  });

  test('non-zero exit code resolves (does not reject)', async () => {
    const proc = spawnProc(['bash', '-c', 'exit 3'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(3);
  });

  test('stderr is captured', async () => {
    const proc = spawnProc(['bash', '-c', 'echo oops 1>&2'], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr.trim()).toBe('oops');
    expect(exitCode).toBe(0);
  });

  test('cwd is honored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sovereign-spawn-'));
    try {
      const proc = spawnProc(['pwd'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      // realpath both sides: macOS tmpdir lives behind the /tmp → /private/tmp symlink.
      expect(realpathSync(stdout.trim())).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stdin round-trip: write + end echoes through cat', async () => {
    const proc = spawnProc(['cat'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const written = proc.stdin.write('hello stdin');
    proc.stdin.end();
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(written).toBe('hello stdin'.length);
    expect(stdout).toBe('hello stdin');
    expect(exitCode).toBe(0);
  });

  test('stdin defaults to ignored (EOF), not an open pipe', async () => {
    // Bun.spawn parity: without stdin:'pipe' the child must see EOF on stdin.
    // node:child_process defaults to an open pipe, which makes stdin-sniffing
    // tools (cat, rg without a path arg) block forever.
    const proc = spawnProc(['cat'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toBe('');
    expect(exitCode).toBe(0);
  });

  test('KILLED_EXIT_CODE is 143 (POSIX 128+SIGTERM), never colliding with rg 0/1/2', () => {
    // A signal-killed child must resolve to 143 — NOT 1 — so GrepTool's
    // `exitCode !== 0 && exitCode !== 1` no-match sentinel can never absorb a
    // kill as an authoritative "no matches" (F15).
    expect(KILLED_EXIT_CODE).toBe(143);
  });

  test('AbortSignal kills the child; exited resolves 143 and signalCode is exposed', async () => {
    const ctl = new AbortController();
    const proc = spawnProc(['bash', '-c', 'sleep 30'], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 50);
    // Intentionally does NOT drain stdout/stderr — exited must not hang on
    // unconsumed pipes (call sites rely on `await proc.exited` resolving).
    const exitCode = await proc.exited;
    // 128+SIGTERM: matches the original Bun.spawn semantics a killed child had.
    expect(exitCode).toBe(143);
    // The shim surfaces WHY the child ended so callers (GrepTool) can tell a
    // kill from a genuine exit code rather than inferring it from the number.
    expect(proc.signalCode).toBe('SIGTERM');
  });

  test('nonexistent binary resolves exited non-zero (no crash, no reject)', async () => {
    const proc = spawnProc(['sovereign-definitely-not-a-real-binary'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // Pin the exact load-bearing value, not just "non-zero": GrepTool and
    // StaticSiteValidateTool branch on `exitCode === SPAWN_FAILURE_EXIT_CODE`
    // to produce their actionable "binary not found" messages — a runtime that
    // resolved spawn-failure to 1 instead would silently degrade a missing
    // ripgrep to "(no matches)" rather than surfacing the real problem.
    expect(exitCode).toBe(SPAWN_FAILURE_EXIT_CODE);
    expect(stdout).toBe('');
  });

  test('pre-aborted signal short-circuits: no spawn, exited resolves KILLED_EXIT_CODE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sovereign-spawn-'));
    const marker = join(dir, 'should-not-exist');
    try {
      const ctl = new AbortController();
      ctl.abort();
      const proc = spawnProc(['bash', '-c', `touch ${marker}`], {
        stdout: 'pipe',
        stderr: 'pipe',
        signal: ctl.signal,
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(KILLED_EXIT_CODE);
      // Pin the concrete value too: the pre-aborted short-circuit resolves 143,
      // not a bare 1 that GrepTool would read as "no matches".
      expect(exitCode).toBe(143);
      expect(stdout).toBe('');
      // No process was ever spawned — the child never ran, so it never
      // created the marker file.
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { toolSubprocessEnv } from '@yevgetman/sov-sdk/util/spawn';

describe('toolSubprocessEnv — credential scrub (SECURITY)', () => {
  test('scrubs provider auth vars, the gateway token, and MCP secrets; keeps everything else', () => {
    const scrubbed = toolSubprocessEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'sk-or',
      MANIFEST_API_KEY: 'mnfst-x',
      SOV_GATEWAY_TOKEN: 'bearer-tok',
      SOV_MCP_GITHUB_TOKEN: 'ghp_x',
      SOV_MCP_LINEAR_API_KEY: 'lin_x',
      MY_OWN_VAR: 'keep-me',
      STRIPE_API_KEY: 'user-own-unrelated', // a *user* var (not a sov provider) — left intact
    });
    // Sensitive: gone.
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.OPENROUTER_API_KEY).toBeUndefined();
    expect(scrubbed.MANIFEST_API_KEY).toBeUndefined();
    expect(scrubbed.SOV_GATEWAY_TOKEN).toBeUndefined();
    expect(scrubbed.SOV_MCP_GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.SOV_MCP_LINEAR_API_KEY).toBeUndefined();
    // Everything else: intact (PATH/HOME + the user's own unrelated vars).
    expect(scrubbed.PATH).toBe('/usr/bin');
    expect(scrubbed.HOME).toBe('/Users/x');
    expect(scrubbed.MY_OWN_VAR).toBe('keep-me');
    expect(scrubbed.STRIPE_API_KEY).toBe('user-own-unrelated');
  });

  test('a spawned child cannot read the provider key from its environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
    try {
      const proc = spawnProc(['bash', '-c', 'echo "[$ANTHROPIC_API_KEY]"'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out.trim()).toBe('[]'); // empty — the key was scrubbed from the child env
      expect(out).not.toContain('sk-must-not-leak');
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
