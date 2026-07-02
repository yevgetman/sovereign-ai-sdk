// Phase 18 T10 — POST /v1/chat/completions client-disconnect propagation.
//
// When the OpenAI client aborts the fetch (closes its side of the socket
// mid-stream), the harness must propagate the disconnect into `query()`
// via AbortSignal so the in-flight provider stream + tool loop stops.
// Matches the OpenAI SDK / openai-python expectation: aborting the
// fetch() context interrupts the backend within a few hundred ms.
//
// The test boots a real Bun.serve via createOpenAIServer (not Hono's
// in-memory app.request) because only a real socket exposes
// c.req.raw.signal as something the test can trigger by cancelling its
// fetch() call. The mock provider is put into `slowMode` so the SSE
// stream stays open long enough to abort mid-flight; without that the
// "Hello world." baseline response races to completion before the test
// can hit AbortController.abort().
//
// Observation: MockProvider.lastSignal captures the AbortSignal that
// reached provider.stream(). After the test fetch aborts, we await a
// short settle window and assert lastSignal.aborted === true — i.e. the
// route bridged c.req.raw.signal all the way down through query() to
// the provider request.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createOpenAIServer } from '../../src/openai/server.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('POST /v1/chat/completions — abort on client disconnect', () => {
  let home: string;
  let runtime: Runtime;
  let server: ReturnType<typeof createOpenAIServer> | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-abort-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    server = createOpenAIServer({
      runtime,
      apiKey: 'test',
      port: 0,
      host: '127.0.0.1',
    });
    // Reset cross-test observation state. The preflight call during
    // buildRuntime captures a signal too, so we wipe AFTER the runtime
    // is up but BEFORE the abort fetch fires.
    MockProvider.lastSignal = undefined;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
  });

  afterEach(async () => {
    if (server) await server.stop();
    MockProvider.lastSignal = undefined;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('aborting the streaming fetch propagates an aborted signal to the provider', async () => {
    if (!server) throw new Error('server failed to boot');
    // slowMode = true gates streamHelloWorld on per-delta sleeps so the
    // SSE stream stays open long enough for the test to abort mid-flight.
    MockProvider.slowMode = true;
    MockProvider.slowModeDelayMs = 200;
    const url = `http://${server.host}:${server.port}/v1/chat/completions`;
    const controller = new AbortController();
    const fetchPromise = fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    // Give the server time to start handling the request and reach
    // provider.stream() so MockProvider.lastSignal is populated with
    // the bridged signal BEFORE we cancel the client side.
    await new Promise((r) => setTimeout(r, 75));
    controller.abort();

    // The fetch() promise rejects with an AbortError once the local
    // fetch state machine notices the controller fired.
    let abortObserved = false;
    try {
      await fetchPromise;
    } catch (err) {
      abortObserved = (err as Error).name.toLowerCase().includes('abort');
    }
    expect(abortObserved).toBe(true);

    // Give the server a moment to react to the disconnect — the abort
    // event needs to propagate from the closed TCP socket through Bun's
    // fetch handler → c.req.raw.signal → our bridge → query() → provider.
    await new Promise((r) => setTimeout(r, 150));

    // The signal MockProvider observed must now be aborted. Without the
    // bridge in chatCompletions.ts this fires false: the signal field
    // is captured but never tripped, and the mock stream runs to
    // completion on the server side.
    expect(MockProvider.lastSignal).toBeDefined();
    expect(MockProvider.lastSignal?.aborted).toBe(true);
  }, 5000);

  test('aborting the non-streaming fetch propagates an aborted signal to the provider', async () => {
    if (!server) throw new Error('server failed to boot');
    MockProvider.slowMode = true;
    MockProvider.slowModeDelayMs = 200;
    const url = `http://${server.host}:${server.port}/v1/chat/completions`;
    const controller = new AbortController();
    const fetchPromise = fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    await new Promise((r) => setTimeout(r, 75));
    controller.abort();

    let abortObserved = false;
    try {
      await fetchPromise;
    } catch (err) {
      abortObserved = (err as Error).name.toLowerCase().includes('abort');
    }
    expect(abortObserved).toBe(true);

    await new Promise((r) => setTimeout(r, 150));

    expect(MockProvider.lastSignal).toBeDefined();
    expect(MockProvider.lastSignal?.aborted).toBe(true);
  }, 5000);
});
