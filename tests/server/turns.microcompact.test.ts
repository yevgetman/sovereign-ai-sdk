// Phase 16.1 M6 T1 — microcompaction wiring through the turns route.
//
// Two-part contract:
//   1. buildRuntime populates `runtime.microcompactConfig` from the caller
//      override (or, when omitted, from userSettings.microcompaction via
//      buildMicrocompactConfig). Without this, the route would forward
//      `undefined` and query() would fall back to DEFAULT_MICROCOMPACT_CONFIG,
//      ignoring the user's settings.
//   2. The turns route forwards `runtime.microcompactConfig` to query() so
//      the configured threshold + keepRecent actually drives microcompaction
//      inside the turn loop.
//
// Verifying (2) end-to-end requires:
//   - prior history with several pre-burst Bash tool_results (microcompact
//     excludes current-burst results — see microcompact.ts header for the
//     boundary rationale, backlog Item 22 / soak case G4)
//   - a provider that returns at least one tool_use on the new turn so the
//     loop reaches the microcompact check after runTools
//   - inspecting the second provider call's messages array — microcompact
//     mutates the in-flight `history` array between iterations, but never
//     persists, so the only observable signal is the next provider call
//
// The default MockProvider's tool-use mode treats ANY prior tool_result as
// "this is a continuation" and short-circuits to "done." — useless here
// because seeded prior tool_results would prevent the new Bash call. We
// inject a small test-local Transport via mutating
// `runtime.resolvedProvider.transport` so the new turn always issues a
// Bash on iteration 0 regardless of seeded history.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, ContentBlock, Message, StreamEvent } from '../../src/core/types.js';
import type { ApiMode, ProviderRequest, ToolSchema, Transport } from '../../src/providers/types.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/**
 * Test-local Transport. Iteration 0 returns a Bash tool_use; iteration 1
 * returns plain text. Detection of "iteration 1" is "the most recent message
 * carries a tool_result block" — narrower than MockProvider's "any message"
 * check so seeded historical tool_results don't trip the continuation
 * branch. Captures every messages array via the static `lastMessages` field
 * keyed by call index so the test can assert what query() handed the
 * provider on call N.
 */
class MicrocompactTestProvider implements Transport<Message, ToolSchema, unknown, never> {
  readonly name = 'mock';
  readonly apiMode: ApiMode = 'anthropic';
  readonly toolUseId = 'mc-test-tool-use-0';

  static callMessages: Message[][] = [];

  static reset(): void {
    MicrocompactTestProvider.callMessages = [];
  }

  toProviderMessages(messages: Message[]): Message[] {
    return messages;
  }

  toProviderTools(tools?: ToolSchema[]): ToolSchema[] | undefined {
    return tools;
  }

  buildKwargs(): unknown {
    return {};
  }

  // biome-ignore lint/correctness/useYield: body is an unconditional throw; the AsyncGenerator return-type signature is required by the Transport interface.
  async *normalizeResponse(): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new Error('normalizeResponse() unused; this transport implements stream() directly.');
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    MicrocompactTestProvider.callMessages.push(req.messages);

    const lastMsg = req.messages[req.messages.length - 1];
    const isContinuation =
      lastMsg !== undefined &&
      lastMsg.role === 'user' &&
      lastMsg.content.some((b) => b.type === 'tool_result');

    if (isContinuation) {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'done.' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const content: ContentBlock[] = [{ type: 'text', text: 'done.' }];
      const assistant: AssistantMessage = { role: 'assistant', content };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    }

    const toolInput = { command: 'echo mc-test' };
    yield { type: 'message_start' };
    yield { type: 'tool_use_delta', id: this.toolUseId, partial: toolInput };
    yield { type: 'message_stop', stop_reason: 'tool_use' };
    const content: ContentBlock[] = [
      { type: 'tool_use', id: this.toolUseId, name: 'Bash', input: toolInput },
    ];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}

/** Seed a Bash tool_use + tool_result pair into the session's persisted
 *  history. Each pair contributes one assistant message (tool_use) and one
 *  user message (tool_result with a long content body so the tool_result
 *  tokens dominate the history and shouldMicrocompact returns true). */
function seedBashPair(
  sessionDb: ReturnType<typeof buildRuntime> extends Promise<infer R>
    ? R extends { sessionDb: infer S }
      ? S
      : never
    : never,
  sessionId: string,
  index: number,
): void {
  const id = `seed-tool-${index}`;
  // Cast through unknown to satisfy SaveMessageInput's Message-shape content.
  (sessionDb as { saveMessage: (sid: string, msg: unknown) => number }).saveMessage(sessionId, {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo seed-${index}` } }],
  });
  (sessionDb as { saveMessage: (sid: string, msg: unknown) => number }).saveMessage(sessionId, {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: `seed-${index} `.repeat(200),
      },
    ],
  });
}

describe('M6 T1 — microcompaction wiring', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-m6-t1-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('buildRuntime populates runtime.microcompactConfig from option override', async () => {
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      microcompactConfig: {
        enabled: true,
        keepRecent: 1,
        triggerThresholdPct: 1,
        compactableTools: new Set(['Bash']),
      },
    });
    try {
      expect(runtime.microcompactConfig.enabled).toBe(true);
      expect(runtime.microcompactConfig.keepRecent).toBe(1);
      expect(runtime.microcompactConfig.triggerThresholdPct).toBe(1);
      expect(runtime.microcompactConfig.compactableTools.has('Bash')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  test('buildRuntime defaults microcompactConfig when no option supplied', async () => {
    // Without an explicit override AND with no userSettings.microcompaction
    // block in config.json, buildMicrocompactConfig returns
    // DEFAULT_MICROCOMPACT_CONFIG. The runtime must still expose a populated
    // value (never undefined) so the route can forward it unconditionally.
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      expect(runtime.microcompactConfig).toBeDefined();
      expect(runtime.microcompactConfig.enabled).toBe(true);
      expect(runtime.microcompactConfig.keepRecent).toBe(5);
      expect(runtime.microcompactConfig.triggerThresholdPct).toBe(40);
    } finally {
      await runtime.dispose();
    }
  });

  test('turns route forwards microcompactConfig: prior tool_results clear inside the turn loop', async () => {
    MicrocompactTestProvider.reset();
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      microcompactConfig: {
        enabled: true,
        keepRecent: 1,
        // Any compactable token triggers — the seeded Bash outputs
        // dominate the (small) history so even 1% suffices.
        triggerThresholdPct: 1,
        compactableTools: new Set(['Bash']),
      },
    });
    try {
      // Replace the resolved transport with the test-local provider so
      // iteration 0 returns Bash regardless of seeded prior tool_results.
      runtime.resolvedProvider.transport = new MicrocompactTestProvider();

      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed 4 prior Bash tool_use+tool_result pairs. Each tool_result body
      // is ~1.6kb so the compactable-token share dominates the (small)
      // history and shouldMicrocompact returns true.
      for (let i = 0; i < 4; i++) {
        seedBashPair(runtime.sessionDb, sessionId, i);
      }

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'do another bash' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      // Drain the SSE stream so the background turn fully completes.
      await eventsRes.text();

      // The transport captured every messages[] handed to it. Iteration 0
      // is the initial call; iteration 1 is the continuation after Bash
      // ran. Microcompaction fires AFTER iteration 0's tool dispatch and
      // mutates the in-flight history before iteration 1's call — so the
      // signal lives in callMessages[1].
      expect(MicrocompactTestProvider.callMessages.length).toBeGreaterThanOrEqual(2);
      const continuationMessages = MicrocompactTestProvider.callMessages[1] ?? [];
      const cleared = continuationMessages.flatMap((m) =>
        m.content.filter(
          (b) => b.type === 'tool_result' && b.content.startsWith('[Tool result cleared'),
        ),
      );
      // With 4 seeded pre-boundary results + keepRecent=1, microcompact
      // clears 3 of them. (The 4th seeded result and the in-flight
      // tool_result both stay — the 4th is within the keepRecent window
      // and the in-flight one is post-boundary.)
      expect(cleared.length).toBe(3);
    } finally {
      MicrocompactTestProvider.reset();
      await runtime.dispose();
    }
  });
});
