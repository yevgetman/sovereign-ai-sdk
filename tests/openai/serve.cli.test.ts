// Phase 18 T3 — integration test: `sov serve` CLI subcommand.
//
// Spawns `bun src/main.ts serve --port <p>` with the mock provider, waits
// for the boot banner, hits /health (auth-exempt) and POST /v1/chat/completions
// (auth-gated, non-streaming branch) against a known port, then sends
// SIGTERM and verifies the process exits 0. Also exercises the
// missing-API-key refusal path.
//
// Uses `Bun.spawn` (not `node:child_process.spawn`) — under heavy parallel
// load inside the full `bun test` suite, the node-bindings spawn was
// killing detached subprocesses at ~5s with no output. Bun.spawn does not
// exhibit that behavior.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitForBoot(stdout: ReadableStream<Uint8Array>, port: number): Promise<void> {
  const stdoutReader = stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 25_000;
  let buf = '';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      stdoutReader.read(),
      new Promise<{ done: true; value: undefined; timeout: true }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined, timeout: true }), remaining),
      ),
    ]);
    if ('timeout' in result) {
      throw new Error(`boot timeout (stdout so far: ${buf})`);
    }
    if (result.done) {
      throw new Error(`stdout closed before banner appeared (stdout so far: ${buf})`);
    }
    buf += decoder.decode(result.value, { stream: true });
    if (buf.includes(String(port))) {
      stdoutReader.releaseLock();
      return;
    }
  }
  throw new Error(`boot timeout (stdout so far: ${buf})`);
}

describe('sov serve CLI', () => {
  test('boots, /health responds, /v1/chat/completions works, shuts down cleanly on SIGTERM', async () => {
    // 8766 avoids collision with the default 8765 in case a real `sov
    // serve` is running on this machine.
    const port = 8766;
    const home = mkdtempSync(join(tmpdir(), 'sov-serve-test-'));
    const proc = Bun.spawn(
      ['bun', 'src/main.ts', 'serve', '--port', String(port), '--no-cron', '--no-preflight'],
      {
        env: {
          ...process.env,
          SOV_TEST_MOCK_PROVIDER: '1',
          SOV_OPENAI_API_KEY: 'test',
          HARNESS_HOME: home,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    try {
      // proc.stdout / proc.stderr are typed `ReadableStream<Uint8Array> |
      // number`; with `stdout: 'pipe'` they're always the stream variant,
      // but TS can't infer that from a string literal — assert here.
      await waitForBoot(proc.stdout as ReadableStream<Uint8Array>, port);

      // /health probe — unauthenticated.
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as { ok?: boolean };
      expect(healthBody.ok).toBe(true);

      // /v1/chat/completions — non-streaming, auth-gated.
      const chatRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'harness-default',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      expect(chatRes.status).toBe(200);
      const chatBody = (await chatRes.json()) as { object?: string };
      expect(chatBody.object).toBe('chat.completion');

      proc.kill('SIGTERM');
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('refuses to boot when API key is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-serve-no-key-'));
    // Strip SOV_OPENAI_API_KEY from the parent env without mutating it —
    // the rest of the parent env (PATH, HOME, etc.) carries through.
    const { SOV_OPENAI_API_KEY: _omit, ...parentEnvWithoutKey } = process.env;
    const env: NodeJS.ProcessEnv = { ...parentEnvWithoutKey, HARNESS_HOME: home };
    const proc = Bun.spawn(
      ['bun', 'src/main.ts', 'serve', '--port', '8767', '--no-cron', '--no-preflight'],
      {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    try {
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/API key/i);
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
