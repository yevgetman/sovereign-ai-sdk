// Real-subprocess tests for the hook runner. Hook scripts are written to a
// temp directory and chmod +x; bun spawns them directly (shell:false). Mirrors
// the bashTool.test.ts pattern of using actual subprocesses kept short and
// deterministic.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookConsentChecker } from '@yevgetman/sov-sdk/hooks/consent';
import { buildHookRunner } from '@yevgetman/sov-sdk/hooks/runner';
import type { HookConfig, HookEventName } from '@yevgetman/sov-sdk/hooks/types';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hook-runner-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeHook(name: string, body: string): string {
  const path = join(workDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const allowAll: HookConsentChecker = async () => 'allow';

function hooksFor(
  event: HookEventName,
  configs: HookConfig[],
): Record<HookEventName, HookConfig[]> {
  return {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
    [event]: configs,
  };
}

describe('hook runner', () => {
  test('PreToolUse: hook receives JSON on stdin and we parse JSON from stdout', async () => {
    const log = writeHook('echo-stdin.sh', 'cat > /dev/stderr; echo \'{"reason":"ok"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        { matcher: 'Bash', hooks: [{ type: 'command', command: log }] },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.block).toBe(false);
  });

  test('exit code 2 blocks; stderr is captured into reason', async () => {
    const path = writeHook('block.sh', 'echo "policy: forbidden" >&2\nexit 2');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        { matcher: '*', hooks: [{ type: 'command', command: path }] },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: {},
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain('policy: forbidden');
  });

  test('exit code other than 0/2 is a soft fail (no block, stderr logged)', async () => {
    const path = writeHook('crash.sh', 'echo "boom" >&2\nexit 7');
    const logged: string[] = [];
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: (m) => logged.push(m),
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: {},
    });
    expect(result.block).toBe(false);
    expect(logged.some((m) => m.includes('boom'))).toBe(true);
  });

  // Polish-pass 2026-07-02 (MEDIUM) — a hook that TRAPS/ignores SIGTERM must
  // not hang the turn forever. The runner SIGTERMs at the deadline, then
  // escalates to SIGKILL after a grace window so `proc.exited` + the stdio
  // reads always settle. The hook here ignores TERM and sleeps 30s with a
  // 300ms configured timeout; the run must still resolve (soft-fail, no block).
  test('a SIGTERM-ignoring hook is SIGKILLed and does not hang the turn', async () => {
    const path = writeHook('trap-term.sh', "trap '' TERM\nsleep 30");
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        { hooks: [{ type: 'command', command: path, timeout: 300 }] },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const started = performance.now();
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: {},
    });
    const elapsed = performance.now() - started;
    // Resolved well before the hook's own 30s sleep — the SIGKILL backstop
    // (300ms deadline + 2s grace) unblocked it.
    expect(elapsed).toBeLessThan(10_000);
    expect(result.block).toBe(false);
  }, 15_000);

  test('PreToolUse: permissionDecision deny blocks with reason', async () => {
    const path = writeHook('deny.sh', 'echo \'{"permissionDecision":"deny","reason":"no Bash"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: {},
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain('no Bash');
  });

  test('PreToolUse: permissionDecision ask is treated as deny (deferred)', async () => {
    const path = writeHook('ask.sh', 'echo \'{"permissionDecision":"ask"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: {},
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("'ask'");
  });

  test('PreToolUse: updatedInput round-trips', async () => {
    const path = writeHook('rewrite.sh', 'echo \'{"updatedInput":{"command":"safe"}}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(result.block).toBe(false);
    expect(result.updatedInput).toEqual({ command: 'safe' });
  });

  test('PostToolUse: additionalContext from multiple hooks concatenates', async () => {
    const a = writeHook('ctxA.sh', 'echo \'{"additionalContext":"line A"}\'');
    const b = writeHook('ctxB.sh', 'echo \'{"additionalContext":"line B"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PostToolUse', [
        {
          hooks: [
            { type: 'command', command: a },
            { type: 'command', command: b },
          ],
        },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PostToolUse', {
      hookEventName: 'PostToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'ok',
      is_error: false,
    });
    expect(result.additionalContext).toBe('line A\n\n---\nline B');
  });

  test('multiple hooks: deny short-circuits remaining', async () => {
    const denyHook = writeHook('blockit.sh', 'echo "stop" >&2\nexit 2');
    const trace = join(workDir, 'after.flag');
    rmSync(trace, { force: true });
    const after = writeHook('after.sh', `echo ran > ${trace}\necho '{}'`);
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        {
          hooks: [
            { type: 'command', command: denyHook },
            { type: 'command', command: after },
          ],
        },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: {},
    });
    expect(result.block).toBe(true);
    // The second hook should never have run.
    const Bun_global = (
      globalThis as { Bun: { file: (p: string) => { exists: () => Promise<boolean> } } }
    ).Bun;
    expect(await Bun_global.file(trace).exists()).toBe(false);
  });

  test('multiple hooks: last updatedInput wins among allows', async () => {
    const a = writeHook('rwA.sh', 'echo \'{"updatedInput":"A"}\'');
    const b = writeHook('rwB.sh', 'echo \'{"updatedInput":"B"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        {
          hooks: [
            { type: 'command', command: a },
            { type: 'command', command: b },
          ],
        },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: 'orig',
    });
    expect(result.updatedInput).toBe('B');
  });

  test('UserPromptSubmit: rewrittenPrompt is consumed', async () => {
    const path = writeHook('rewrite-prompt.sh', 'echo \'{"rewrittenPrompt":"redacted"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('UserPromptSubmit', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('UserPromptSubmit', {
      hookEventName: 'UserPromptSubmit',
      session_id: 's',
      cwd: workDir,
      prompt: 'API_KEY=secret',
    });
    expect(result.rewrittenPrompt).toBe('redacted');
  });

  test('consent denial makes a hook inert (no spawn, no block)', async () => {
    const path = writeHook('would-block.sh', 'exit 2');
    const denyAll: HookConsentChecker = async () => 'deny';
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: denyAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: {},
    });
    expect(result.block).toBe(false);
  });

  // FIX 1 — a transient `'skip'` (no recorded consent, no interactive prompt)
  // must NOT spawn the hook and MUST emit a one-line awaiting-consent notice.
  test('consent skip: hook is inert, awaiting-consent notice logged, no block', async () => {
    const path = writeHook('would-skip.sh', 'exit 2');
    const skipAll: HookConsentChecker = async () => 'skip';
    const logged: string[] = [];
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: skipAll,
      logStderr: (m) => logged.push(m),
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: {},
    });
    expect(result.block).toBe(false);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('awaiting consent');
    expect(logged[0]).toContain(path);
    expect(logged[0]).toContain('shell-hooks-allowlist.json');
  });

  // FIX 3 — a hook that exits 2 with NO output must still surface a reason that
  // names the command (the empty-string stderr must not become the reason).
  test('exit code 2 with no output yields a reason naming the command', async () => {
    const path = writeHook('silent-block.sh', 'exit 2');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [{ hooks: [{ type: 'command', command: path }] }]),
      consent: allowAll,
      logStderr: () => {},
    });
    const result = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'X',
      tool_input: {},
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain('hook exit 2');
    expect(result.reason).toContain(path);
  });

  test('matcher: literal tool name only fires for that tool', async () => {
    const path = writeHook('only-bash.sh', 'echo \'{"updatedInput":"matched"}\'');
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        { matcher: 'Bash', hooks: [{ type: 'command', command: path }] },
      ]),
      consent: allowAll,
      logStderr: () => {},
    });
    const a = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Bash',
      tool_input: 'x',
    });
    expect(a.updatedInput).toBe('matched');
    const b = await run('PreToolUse', {
      hookEventName: 'PreToolUse',
      session_id: 's',
      cwd: workDir,
      tool_name: 'Read',
      tool_input: 'x',
    });
    expect(b.updatedInput).toBeUndefined();
  });
});
