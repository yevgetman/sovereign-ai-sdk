// Regression for finding #41 — the awaiting-consent notice (the signal emitted
// for a transient 'skip') must be de-duped per (event, command) for the
// lifetime of the runner closure. A `matcher: "*"` PreToolUse hook with no
// recorded consent would otherwise log one identical line per tool invocation
// per turn — thousands over a long-lived gateway session.

import { describe, expect, test } from 'bun:test';
import type { HookConsentChecker } from '../../src/hooks/consent.js';
import { buildHookRunner } from '../../src/hooks/runner.js';
import type { HookConfig, HookEvent, HookEventName } from '../../src/hooks/types.js';

const skipAll: HookConsentChecker = async () => 'skip';

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

function preToolUse(toolName: string): HookEvent {
  return {
    hookEventName: 'PreToolUse',
    session_id: 's',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: {},
  };
}

describe('hook runner — awaiting-consent notice de-dup (finding #41)', () => {
  test('logs the awaiting-consent notice ONCE across many skipped calls of the same hook', async () => {
    const logged: string[] = [];
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        { matcher: '*', hooks: [{ type: 'command', command: '/usr/bin/true' }] },
      ]),
      consent: skipAll,
      logStderr: (m) => logged.push(m),
    });

    // Simulate a turn with many tool calls — every one hits the skip path.
    for (let i = 0; i < 20; i++) {
      const result = await run('PreToolUse', preToolUse(`Tool${i}`));
      expect(result.block).toBe(false);
    }

    // The bug logged 20 identical lines; the fix logs exactly one.
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('awaiting consent');
    expect(logged[0]).toContain('/usr/bin/true');
    expect(logged[0]).toContain('shell-hooks-allowlist.json');
  });

  test('still emits a distinct notice per distinct (event, command)', async () => {
    const logged: string[] = [];
    const run = buildHookRunner({
      hooksByEvent: hooksFor('PreToolUse', [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: '/bin/cmd-a' },
            { type: 'command', command: '/bin/cmd-b' },
          ],
        },
      ]),
      consent: skipAll,
      logStderr: (m) => logged.push(m),
    });

    await run('PreToolUse', preToolUse('Bash'));
    await run('PreToolUse', preToolUse('Bash'));

    // Two distinct commands → two notices, but each only once.
    expect(logged.length).toBe(2);
    expect(logged.some((m) => m.includes('/bin/cmd-a'))).toBe(true);
    expect(logged.some((m) => m.includes('/bin/cmd-b'))).toBe(true);
  });
});
