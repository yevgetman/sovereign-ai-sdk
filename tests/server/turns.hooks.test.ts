// Phase 16.1 M5 T2 — turns route forwards hookRunner to query().
//
// T1 wired hookRunner construction in buildRuntime. T2 makes it useful by
// passing it to query() so UserPromptSubmit / PreToolUse / PostToolUse / Stop
// hooks actually fire during a turn. This test asserts the wiring is live by
// configuring a UserPromptSubmit hook that writes to a trace file, running a
// turn through the route handler, and checking the file exists.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — hookRunner is forwarded to query()', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let traceFile: string;
  let hookScript: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-t2-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-t2-cwd-'));
    traceFile = join(tmpCwd, 'trace.log');
    hookScript = join(tmpCwd, 'fire.sh');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('UserPromptSubmit hook fires when a turn is submitted via POST /turns', async () => {
    // Settings: one UserPromptSubmit hook that writes 'fired' to the trace
    // file. argvSplit is shell:false (no redirection / pipes); the runner
    // spawns the argv directly. So we write a real shell script that does
    // the redirection and reference its path as the hook command. Mirrors
    // tests/hooks/runner.test.ts's `writeHook` pattern. UserPromptSubmit
    // ignores the matcher per src/hooks/matcher.ts, so '*' is cosmetic.
    writeFileSync(hookScript, `#!/usr/bin/env bash\necho fired > '${traceFile}'\n`, 'utf8');
    chmodSync(hookScript, 0o755);
    const hookCommand = hookScript;
    const settingsPath = join(tmpHome, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
        },
      }),
    );

    // Pre-consent the command (server-mode consent gate is non-interactive
    // and denies by default — see M5-01 in src/server/runtime.ts). Schema
    // matches src/hooks/consent.ts: { version: 1, decisions: { '<event>:<cmd>': 'allow' } }.
    const allowlistPath = join(tmpHome, 'shell-hooks-allowlist.json');
    writeFileSync(
      allowlistPath,
      JSON.stringify({
        version: 1,
        decisions: {
          [`UserPromptSubmit:${hookCommand}`]: 'allow',
        },
      }),
    );

    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      try {
        const app = buildAppWithRuntime(runtime);

        const createRes = await app.request('/sessions', { method: 'POST' });
        expect(createRes.status).toBe(201);
        const { sessionId } = (await createRes.json()) as { sessionId: string };

        const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hello' }),
        });
        expect(turnRes.status).toBe(202);

        // Drain the SSE stream — blocks until turn_complete which means the
        // background turn loop has fully resolved, including all hook
        // invocations. This is the same drain pattern used by every other
        // turns test; it's more reliable than a fixed sleep.
        const eventsRes = await app.request(`/sessions/${sessionId}/events`);
        expect(eventsRes.status).toBe(200);
        await eventsRes.text();

        // The hook must have run — trace file present + contains 'fired'.
        expect(existsSync(traceFile)).toBe(true);
        expect(readFileSync(traceFile, 'utf8')).toContain('fired');
      } finally {
        await runtime.dispose();
      }
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
    }
  });
});
