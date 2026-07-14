// Item 3 — buffered-mode delivery to the live UI.
//
// A provider running in buffered (non-streaming) mode emits ZERO
// `text_delta` events; its whole response arrives as the final
// `assistant_message`. Before this fix, `handleAssistantMessage` dropped
// every non-`tool_use` block, so buffered text NEVER reached the live SSE
// stream — the TUI showed a turn that "completed" with no visible answer.
//
// The fix tracks a turn-level `sawTextDelta` flag; when a turn ends with a
// text-bearing final message but nothing streamed, each `type:'text'`
// block is projected onto the wire as a `text_delta` server event (reusing
// the existing shape — zero client change). When ANY text_delta streamed,
// the branch is skipped so the streaming path stays byte-identical.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../packages/sdk/src/providers/mock.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** Drain the SSE stream and return the `text` of every `text_delta` event,
 *  in wire order. */
function textDeltas(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice('data: '.length).trim();
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { type?: string; text?: string };
      if (parsed.type === 'text_delta' && typeof parsed.text === 'string') {
        out.push(parsed.text);
      }
    } catch {
      // framing-only line — ignore.
    }
  }
  return out;
}

async function driveTurn(tmpHome: string, prompt: string): Promise<string> {
  const runtime = await buildRuntime({
    cwd: tmpHome,
    harnessHome: tmpHome,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
  });
  try {
    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt }),
    });
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    return await eventsRes.text();
  } finally {
    await runtime.dispose();
  }
}

describe('turns route — buffered-mode delivery (Item 3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-buffered-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.bufferedMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('buffered turn (no text_delta streamed) projects the final text onto the wire', async () => {
    MockProvider.bufferedMode = true;

    const body = await driveTurn(tmpHome, 'hello');

    // The buffered mock emits a single text block and NO text_delta events;
    // the delivery branch must project that final text as one text_delta.
    expect(textDeltas(body)).toEqual(['Buffered hello.']);
  });

  test('streaming turn stays byte-identical — no extra text_delta from the final message', async () => {
    // Default mock streams "Hello" + " world." as two text_delta events and
    // ALSO carries the accumulated "Hello world." on the assistant_message.
    // Because deltas streamed, the delivery branch must be skipped — the wire
    // sees exactly the two streamed deltas, never the accumulated full text.
    const body = await driveTurn(tmpHome, 'hi');

    expect(textDeltas(body)).toEqual(['Hello', ' world.']);
  });
});
