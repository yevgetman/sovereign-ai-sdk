// Phase 16.1 M5 T1 — buildRuntime constructs a HookRunner.
//
// The runner is exposed on Runtime so the turns route can pass it to query().
// Server-mode consent gate is non-interactive (M5-01): commands not already in
// ~/.harness/shell-hooks-allowlist.json are denied without prompting (the
// server doesn't own a TTY). The allowlist must be pre-populated out of
// band (e.g., by editing the JSON directly).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('runtime — hookRunner construction', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-hooks-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-hooks-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('exposes hookRunner on Runtime when settings has hooks', async () => {
    const settingsPath = join(tmpHome, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo bash-fired' }],
            },
          ],
        },
      }),
    );
    // Pre-consent the command via the file-backed consent store schema
    // (key shape: `<eventName>:<command-string>`). Without this, the
    // server-mode consent checker denies the hook (M5-01), the matching
    // hook is treated as inert, and the runner returns block:false anyway
    // — but pre-consenting exercises the allow path so the test covers
    // the wiring end-to-end.
    const allowlistPath = join(tmpHome, 'shell-hooks-allowlist.json');
    writeFileSync(
      allowlistPath,
      JSON.stringify({
        version: 1,
        decisions: {
          'PreToolUse:echo bash-fired': 'allow',
        },
      }),
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    try {
      expect(runtime.hookRunner).toBeDefined();
      expect(typeof runtime.hookRunner).toBe('function');

      const result = await runtime.hookRunner('PreToolUse', {
        hookEventName: 'PreToolUse',
        session_id: 'test-session',
        cwd: tmpCwd,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(result.block).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('hookRunner is a no-op when settings has no hooks block', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    try {
      expect(runtime.hookRunner).toBeDefined();
      const result = await runtime.hookRunner('PreToolUse', {
        hookEventName: 'PreToolUse',
        session_id: 'test-session',
        cwd: tmpCwd,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(result.block).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
