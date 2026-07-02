// Unit tests for the hook matcher. The orchestrator passes CANONICAL tool
// names (FileEdit / FileWrite / FileRead / Bash) on the event, while operators
// naturally write matchers using the familiar aliases (Edit / Write / Read) and
// pipe-alternation ("Edit|Write"). The matcher must reconcile both.

import { describe, expect, test } from 'bun:test';
import { matchesHook } from '@yevgetman/sov-sdk/hooks/matcher';
import type { HookConfig, HookEvent } from '@yevgetman/sov-sdk/hooks/types';

function preEvent(toolName: string): HookEvent {
  return {
    hookEventName: 'PreToolUse',
    session_id: 's',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: {},
  };
}

function postEvent(toolName: string): HookEvent {
  return {
    hookEventName: 'PostToolUse',
    session_id: 's',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: {},
    tool_output: 'ok',
    is_error: false,
  };
}

function cfg(matcher: string | undefined): HookConfig {
  return { ...(matcher !== undefined ? { matcher } : {}), hooks: [] };
}

describe('matchesHook', () => {
  test('exact canonical name matches', () => {
    expect(matchesHook(cfg('Bash'), preEvent('Bash'))).toBe(true);
  });

  test('wildcard "*" matches anything', () => {
    expect(matchesHook(cfg('*'), preEvent('Bash'))).toBe(true);
    expect(matchesHook(cfg('*'), preEvent('FileEdit'))).toBe(true);
  });

  test('empty / undefined matcher matches anything', () => {
    expect(matchesHook(cfg(''), preEvent('FileEdit'))).toBe(true);
    expect(matchesHook(cfg(undefined), preEvent('FileWrite'))).toBe(true);
  });

  test('an unrelated name does not match', () => {
    expect(matchesHook(cfg('Bash'), preEvent('FileEdit'))).toBe(false);
    expect(matchesHook(cfg('Grep'), preEvent('FileRead'))).toBe(false);
  });

  // FIX 2(b) — alias matching: "Edit" must fire for the canonical FileEdit.
  test('alias "Edit" matches a FileEdit event', () => {
    expect(matchesHook(cfg('Edit'), preEvent('FileEdit'))).toBe(true);
  });

  test('alias "Write" matches a FileWrite event', () => {
    expect(matchesHook(cfg('Write'), preEvent('FileWrite'))).toBe(true);
  });

  test('alias "Read" matches a FileRead event', () => {
    expect(matchesHook(cfg('Read'), preEvent('FileRead'))).toBe(true);
  });

  test('the canonical name also still matches directly', () => {
    expect(matchesHook(cfg('FileEdit'), preEvent('FileEdit'))).toBe(true);
  });

  // FIX 2(a) — pipe-alternation.
  test('"Edit|Write" alternation matches a FileEdit event', () => {
    expect(matchesHook(cfg('Edit|Write'), preEvent('FileEdit'))).toBe(true);
  });

  test('"Edit|Write" alternation matches a FileWrite event', () => {
    expect(matchesHook(cfg('Edit|Write'), postEvent('FileWrite'))).toBe(true);
  });

  test('"Edit|Write" alternation does NOT match an unrelated tool', () => {
    expect(matchesHook(cfg('Edit|Write'), preEvent('Bash'))).toBe(false);
  });

  test('alternation of canonical names works too', () => {
    expect(matchesHook(cfg('Bash|Grep'), preEvent('Grep'))).toBe(true);
    expect(matchesHook(cfg('Bash|Grep'), preEvent('FileEdit'))).toBe(false);
  });

  test('an alternation containing "*" matches anything', () => {
    expect(matchesHook(cfg('Bash|*'), preEvent('Anything'))).toBe(true);
  });

  test('whitespace around alternatives is tolerated', () => {
    expect(matchesHook(cfg('Edit | Write'), preEvent('FileEdit'))).toBe(true);
  });

  test('non-tool events (UserPromptSubmit) always match regardless of matcher', () => {
    const event: HookEvent = {
      hookEventName: 'UserPromptSubmit',
      session_id: 's',
      cwd: '/tmp',
      prompt: 'hi',
    };
    expect(matchesHook(cfg('Bash'), event)).toBe(true);
  });
});
