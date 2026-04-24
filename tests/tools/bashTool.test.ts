// BashTool tests. These run real bash subprocesses — kept minimal and
// fast so the test suite stays under a second.

import { describe, expect, test } from 'bun:test';
import { BashTool, formatBashOutput, isBashError } from '../../src/tools/BashTool.js';

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

  test('fail-closed defaults inherited from buildTool', () => {
    // Sanity: Phase 0 defaults carry through — isReadOnly and
    // isConcurrencySafe stay false until a phase turns them on.
    expect(BashTool.isReadOnly({ command: 'echo 1' })).toBe(false);
    expect(BashTool.isConcurrencySafe({ command: 'echo 1' })).toBe(false);
    expect(BashTool.isDestructive({ command: 'echo 1' })).toBe(false);
    expect(BashTool.shouldDefer).toBe(false);
  });
});
