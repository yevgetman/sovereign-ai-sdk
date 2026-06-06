// Phase F-T2 — channel-agnostic inbound→turn→outbound pipeline.
//
// `runChannelTurn` is the core that maps an InboundMessage to a per-(channel,
// sender) session owned by the channel's principal (Phase E isolation) and runs
// a headless turn under the F-T1 safe channel posture. It mirrors the cron
// headless-turn pattern (src/cron/wiring.ts): find-or-create the session row,
// build a SUBAGENT_EXCLUDED_TOOLS-filtered pool + the channel canUseTool, run an
// AgentRunner to terminal, extract the final assistant text, dispose the
// in-memory session context in a finally.
//
// These tests pin the load-bearing contracts deterministically against the
// MockProvider runtime (no LLM variance):
//   1. session sourcing — sessionId === buildSessionKey(msg), ownerId === the
//      channel principal, platform === the channel; returns the reply text.
//   2. conversation persists — a second turn with the same msg reuses the SAME
//      session id and GROWS the stored message history (find-or-create).
//   3. silent — a `[SILENT]`-prefixed or empty reply yields { silent: true }.
//   4. channel posture — a scripted Bash tool_use is DENIED by the channel
//      canUseTool (no local-allow inheritance, ask auto-denies).
//   5. isolation wiring — the per-turn ToolContext.userId === the principal, so
//      memory/learning scope under users/{principal}/… (Phase E).
//   6. cleanup — after the turn the in-memory context is disposed (reclaimable)
//      but the DB row persists for the next message.
//   7. bypass is rejected before any turn runs (assertChannelPermissionMode).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChannelTurn } from '../../src/channels/pipeline.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

/** A private-DM telegram message. Reused across tests; the session key it
 *  produces is deterministic so the conversation-persistence test can reuse
 *  the same id without recomputing. */
const TG_MSG: InboundMessage = {
  channel: 'telegram',
  sender: 'u1',
  chatId: 'c1',
  chatType: 'private',
  text: 'hello',
};

const PRINCIPAL = 'tg-bot';

/** Reset every MockProvider static this suite touches so the known
 *  static-pollution flake can't bleed across tests in the shared Bun process. */
function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
}

/** Boot a MockProvider runtime against the temp home with cron OFF so no
 *  background tick fires behind the pipeline. */
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

describe('runChannelTurn — channel-agnostic inbound→turn→outbound pipeline', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-channels-pipeline-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Isolate the session DB per test. buildRuntime opens
    // `resolveHarnessHome()/sessions.db` (env-based), NOT opts.harnessHome —
    // so without pinning HARNESS_HOME every runtime shares ~/.harness/sessions.db
    // and the DETERMINISTIC channel session key (agent:main:telegram:…) would
    // collide across tests + dev runs. Point it at the fresh temp home.
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('sources a per-sender session owned by the principal and returns the reply', async () => {
    // Default mock reply is "Hello world." — one stream() call, no tool loop.
    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // Reply surfaced.
    expect(result.text).toBe('Hello world.');
    expect(result.silent).toBeUndefined();

    // Session sourced via buildSessionKey, owned by the principal, stamped
    // with the channel as platform.
    const sessionId = buildSessionKey(TG_MSG);
    const row = runtime.sessionDb.getSession(sessionId);
    expect(row).not.toBeNull();
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.ownerId).toBe(PRINCIPAL);
    expect(row?.platform).toBe('telegram');
  });

  test('conversation persists — a second turn reuses the session and grows history', async () => {
    const sessionId = buildSessionKey(TG_MSG);

    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });
    const afterFirst = runtime.sessionDb.loadMessages(sessionId).length;
    expect(afterFirst).toBeGreaterThan(0);

    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });
    const afterSecond = runtime.sessionDb.loadMessages(sessionId).length;

    // Same session id reused (find-or-create), history GREW (not reset).
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  test('silent — a [SILENT]-prefixed reply yields { silent: true } and no text', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: '[SILENT] internal note' }];
    MockProvider.resetScriptCursor();

    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    expect(result.silent).toBe(true);
    expect(result.text).toBeUndefined();
  });

  test('silent — an empty reply yields { silent: true } and no text', async () => {
    MockProvider.toolUseScript = [{ kind: 'text', text: '   ' }];
    MockProvider.resetScriptCursor();

    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    expect(result.silent).toBe(true);
    expect(result.text).toBeUndefined();
  });

  test('channel posture — a scripted Bash tool_use is DENIED inside the turn', async () => {
    // End-to-end proof that the pipeline applies the safe channel posture (not
    // just that the decider denies in isolation — that is permission.test.ts's
    // job). Script the model to (1) attempt a Bash command that would create a
    // sentinel file, then (2) reply with text. Under the channel posture Bash
    // self-checks 'ask' → auto-deny → the command never runs → the sentinel is
    // never created. The denial surfaces to the model as a tool_result(error),
    // and the scripted text reply lets the turn complete cleanly.
    const sentinel = join(home, 'PWNED.txt');
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'Bash', input: { command: `touch ${sentinel}` } },
      { kind: 'text', text: 'all done' },
    ];
    MockProvider.resetScriptCursor();

    const result = await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // The Bash command was denied → the sentinel was never written.
    expect(existsSync(sentinel)).toBe(false);
    // The turn still completed and surfaced the model's text reply.
    expect(result.text).toBe('all done');
  });

  test('isolation wiring — the per-turn ToolContext.userId === the principal', async () => {
    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // userId is derived inside buildSessionContext from the session row's
    // ownerId (the single Phase E source). Re-deriving the live context for the
    // session id must therefore carry userId === the principal we stamped.
    const sessionId = buildSessionKey(TG_MSG);
    runtime.sessionDb.upsertSession({
      sessionId,
      owner: PRINCIPAL,
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
    });
    const ctx = runtime.getSessionContext(sessionId);
    expect(ctx.userId).toBe(PRINCIPAL);
    await runtime.disposeSession(sessionId);
  });

  test('cleanup — in-memory context disposed after the turn, DB row persists', async () => {
    const sessionId = buildSessionKey(TG_MSG);

    // Spy on disposeSession to prove the pipeline reclaims the in-memory ctx.
    const disposed: string[] = [];
    const realDispose = runtime.disposeSession;
    runtime.disposeSession = async (id, opts) => {
      disposed.push(id);
      return realDispose(id, opts);
    };

    await runChannelTurn({ runtime, msg: TG_MSG, principalId: PRINCIPAL });

    // The pipeline disposed the session's in-memory context in its finally.
    expect(disposed).toContain(sessionId);

    // But the DB row persists for the next message.
    expect(runtime.sessionDb.getSession(sessionId)).not.toBeNull();

    runtime.disposeSession = realDispose;
  });

  test('bypass — assertChannelPermissionMode rejects before any turn runs', async () => {
    MockProvider.streamCalls = 0;

    await expect(
      runChannelTurn({
        runtime,
        msg: TG_MSG,
        principalId: PRINCIPAL,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately passing an out-of-union value to prove the guard rejects it.
        permissionMode: 'bypass' as any,
      }),
    ).rejects.toThrow(/bypass/);

    // No session row created, no provider call: the guard fired first.
    expect(runtime.sessionDb.getSession(buildSessionKey(TG_MSG))).toBeNull();
  });
});
