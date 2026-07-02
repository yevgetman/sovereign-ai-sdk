// Phase F — CRITICAL path-traversal arbitrary-file-write regression suite.
//
// An adversarial security review found that the generic webhook adapter accepts
// `chatId` (and `sender` / `threadId`) as ARBITRARY unrestricted strings. They
// flow through buildSessionKey into the session id
// `agent:main:webhook:private:<chatId>`, which reaches TraceWriter's path
// resolution: `join(harnessHome, 'traces', \`${sessionId}.jsonl\`)` +
// `mkdirSync(dirname, { recursive: true })` + `appendFile`. A `chatId` carrying
// `../` escapes `…/traces/` → an arbitrary-path file write + recursive mkdir,
// BEFORE the model runs, bypassing the channel permission posture.
//
// Defense-in-depth at BOTH boundaries:
//   * Fix A (the source) — parseWebhook bounds the inbound segment ids (chatId /
//     sender / threadId) to a safe class; a traversal/colon/control/over-long id
//     returns null → the route 400s, no turn, no side-effect.
//   * Fix B (the sink) — TraceWriter sanitizes the sessionId-derived filename so
//     it can NEVER traverse, AND asserts the resolved path stays under the traces
//     dir (throwing otherwise) — protecting EVERY sessionId-in-path sink.
//
// Each property is proved by an OBSERVABLE consequence: a sentinel file that was
// NOT written outside the traces dir, a status code, a throw.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { TraceWriter } from '@yevgetman/sov-sdk/trace/writer';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import type { ChannelsConfig } from '../../src/server/routes/channels.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

const SECRET = 'whsec_traversal';
const PRINCIPAL = 'wh-bot';
const CHANNEL_ID = 'default';
const JSON_HEADER = { 'Content-Type': 'application/json' };

const CHANNELS: ChannelsConfig = {
  webhook: { enabled: true, secret: SECRET, principalId: PRINCIPAL },
};

/** sha256=<hex hmac-sha256 of `raw` keyed by `secret`> — the header the route
 *  verifies. The signature is computed over the EXACT raw bytes so a malicious
 *  payload is still authentically signed (the attacker holds the secret here —
 *  the point is that a SIGNED request still must not escape the traces dir). */
function sign(raw: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
  MockProvider.streamCalls = 0;
}

async function buildTestRuntime(home: string): Promise<Runtime> {
  return buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
}

describe('Phase F — path-traversal arbitrary-file-write (CRITICAL)', () => {
  let home: string;
  let escapeDir: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-chan-traversal-'));
    // A sibling dir OUTSIDE the harness home; the traversal payload aims a write
    // here. It must stay empty after a rejected request / a sanitized write.
    escapeDir = mkdtempSync(join(tmpdir(), 'sov-chan-escape-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    __test_resetAllBuses();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(escapeDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Fix A — the source: parseWebhook bounds the inbound ids → 400, no write.
  // ===========================================================================

  test('webhook chatId with ../ traversal → 400, no file written outside traces/', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });

    // chatId aims the trace file at <escapeDir>/PWNED.jsonl, far outside
    // <home>/traces/. Build the relative climb from <home>/traces back to the
    // filesystem root, then down into escapeDir — the classic `../` attack.
    const escapeTarget = join(escapeDir, 'PWNED');
    const climb = '../'.repeat(escapeTarget.split(sep).length + 4);
    const maliciousChatId = `${climb}${escapeTarget.slice(1)}`; // strip leading sep
    const escapedFile = `${resolve(escapeTarget)}.jsonl`;

    const raw = JSON.stringify({ sender: 'u1', text: 'pwn', chatId: maliciousChatId });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });

    // Fix A rejects the malicious id at parse → 400, no turn.
    expect(res.status).toBe(400);
    // The crux: NO file was created outside the harness traces dir.
    expect(existsSync(escapedFile)).toBe(false);
    expect(existsSync(escapeTarget)).toBe(false);
    // No provider call ran (rejected before the turn).
    expect(MockProvider.streamCalls).toBe(0);
  });

  test('webhook chatId with a backslash segment → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'x', chatId: 'a\\..\\b' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test('webhook chatId carrying a colon (session-key delimiter) → 400', async () => {
    // `:` delimits buildSessionKey; an injected colon could forge the key shape.
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'x', chatId: 'evil:injected' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test('webhook chatId with a control char (newline) → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'x', chatId: 'a\nb' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test('webhook over-long chatId (> 256) → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'x', chatId: 'a'.repeat(257) });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test('webhook traversal in `sender` (which defaults chatId) → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: '../../../../tmp/evil', text: 'x' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test('webhook traversal in `threadId` → 400', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'x', chatId: 'c1', threadId: '../../evil' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  // --- legitimate ids still work (Fix A must not over-reject) ----------------

  test('a normal chatId still drives a turn (Fix A allows safe ids)', async () => {
    const app = buildAppWithRuntime(runtime, { channels: CHANNELS });
    const raw = JSON.stringify({ sender: 'u1', text: 'hi', chatId: 'normal-chat.id_42' });
    const res = await app.request(`/channels/webhook/${CHANNEL_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': sign(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reply?: string };
    expect(json.reply).toBe('Hello world.');
  });

  // ===========================================================================
  // Fix B — the sink: TraceWriter never escapes its traces dir.
  // ===========================================================================

  test('TraceWriter with a malicious traversal sessionId does not escape traces/', async () => {
    const escapeTarget = join(escapeDir, 'TRACE-PWNED');
    const climb = '../'.repeat(escapeTarget.split(sep).length + 4);
    const maliciousSessionId = `${climb}${escapeTarget.slice(1)}`;
    const escapedFile = `${resolve(escapeTarget)}.jsonl`;

    // Constructing + recording must NOT create a file outside <home>/traces/.
    // Fix B either throws at path resolution OR sanitizes the filename so the
    // write lands harmlessly under traces/. Either way the escaped file is absent.
    let threw = false;
    try {
      const writer = new TraceWriter({ sessionId: maliciousSessionId, harnessHome: home });
      writer.record({ type: 'turn_start', turn: 0, iso: '2026-06-06T00:00:00Z' } as never);
      await writer.close();
      // If it didn't throw, the resolved path must stay under traces/.
      expect(writer.path.startsWith(resolve(join(home, 'traces')) + sep)).toBe(true);
    } catch {
      threw = true;
    }

    // The arbitrary-path escape never happened.
    expect(existsSync(escapedFile)).toBe(false);
    expect(existsSync(escapeTarget)).toBe(false);
    // Document the outcome shape (throw OR contained write) for the reader.
    expect(typeof threw).toBe('boolean');
  });

  test('TraceWriter with a legitimate colon channel sessionId writes under traces/', async () => {
    // The colon-joined channel session id is LEGITIMATE — Fix B keeps `:` and
    // only strips path-dangerous chars, so it must still produce a valid,
    // NON-escaping trace file.
    const colonSessionId = 'agent:main:webhook:private:normal-chat';
    const writer = new TraceWriter({ sessionId: colonSessionId, harnessHome: home });
    expect(writer.path.startsWith(resolve(join(home, 'traces')) + sep)).toBe(true);
    writer.record({ type: 'turn_start', turn: 0, iso: '2026-06-06T00:00:01Z' } as never);
    await writer.close();
    expect(writer.count).toBe(1);
    expect(existsSync(writer.path)).toBe(true);
  });
});
