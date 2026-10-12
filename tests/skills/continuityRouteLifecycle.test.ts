import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { wrapTransportWithOverflow } from '../helpers/transportWrappers.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-continuity-route-'));
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  mkdirSync(join(home, '.harness', 'skills'), { recursive: true });
  writeFileSync(
    join(home, '.harness', 'skills', 'checked.md'),
    '---\nname: checked\ndescription: Checked workflow\nwhenToUse: User asks for a checked workflow\nallowedTools: [Read]\n---\nKeep the accepted workflow.\n',
  );
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires delete.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
  rmSync(home, { recursive: true, force: true });
});

for (const result of ['completed', 'error', 'max_tokens', 'interrupted'] as const) {
  test(`SOV slash activation records its actual ${result} query outcome`, async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      settings: {
        learning: { disabled: true, recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 } },
        review: { disabled: true },
      },
    });
    let notifyEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const provider: LLMProvider = {
      name: 'mock',
      async *stream(request) {
        yield { type: 'message_start' };
        if (result === 'error') throw new Error('PRIVATE_PROVIDER_FAILURE');
        if (result === 'interrupted') {
          notifyEntered();
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(new Error('PRIVATE_CANCEL_FAILURE'));
            if (!request.signal || request.signal.aborted) fail();
            else request.signal.addEventListener('abort', fail, { once: true });
          });
        }
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Checked.' }],
        };
        yield { type: 'assistant_message', message };
        yield {
          type: 'message_stop',
          stop_reason: result === 'max_tokens' ? 'max_tokens' : 'end_turn',
        };
        return message;
      },
    };
    runtime.resolvedProvider.transport.stream = provider.stream.bind(provider);
    try {
      const app = buildAppWithRuntime(runtime);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      const response = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/checked', kind: 'skill' }),
      });
      expect(response.status).toBe(202);
      if (result === 'interrupted') {
        await entered;
        const cancelled = await app.request(`/sessions/${sessionId}/cancel`, { method: 'POST' });
        expect(cancelled.status).toBe(200);
      }
      await (await app.request(`/sessions/${sessionId}/events`)).text();
      const continuity = runtime.getSessionContext(sessionId).skillContinuity;
      if (!continuity) throw new Error('missing trusted continuity');
      const records = await continuity.exportRecords();
      const outcome =
        result === 'completed' ? 'succeeded' : result === 'interrupted' ? 'cancelled' : 'failed';
      expect(records[0]?.outcome).toBe(outcome);
      expect(records[0]?.guidance).toBe('Keep the accepted workflow.');
      expect(continuity.diagnostics().filter((event) => event.code === outcome)).toHaveLength(1);
      expect(JSON.stringify(continuity.diagnostics())).not.toContain('PRIVATE_PROVIDER_FAILURE');
      expect(JSON.stringify(continuity.diagnostics())).not.toContain('PRIVATE_CANCEL_FAILURE');
    } finally {
      await runtime.dispose();
    }
  });
}

for (const mode of ['failure', 'cancel'] as const) {
  test(`SOV settles successful activation when pre-query compaction ends with ${mode}`, async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      preflight: false,
      proactiveCompactThreshold: 0.000001,
      settings: {
        learning: { disabled: true, recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 } },
        review: { disabled: true },
      },
    });
    runtime.systemSegments.splice(0);
    let notifyEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    let providerCalls = 0;
    const original = runtime.resolvedProvider.transport.stream.bind(
      runtime.resolvedProvider.transport,
    );
    runtime.resolvedProvider.transport.stream = async function* (request) {
      providerCalls++;
      return yield* original(request);
    };
    runtime.compact = async (_messages, _sessionId, signal) => {
      notifyEntered();
      if (mode === 'cancel') {
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(new Error('CONTROLLED_PREQUERY_CANCELLATION'));
          if (!signal || signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      }
      throw new Error('CONTROLLED_PREQUERY_FAILURE');
    };
    try {
      const app = buildAppWithRuntime(runtime);
      const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
        sessionId: string;
      };
      const continuity = runtime.getSessionContext(sessionId).skillContinuity;
      if (!continuity) throw new Error('missing trusted continuity');
      await continuity.activated(
        {
          name: 'older',
          revision: 'a'.repeat(64),
          source: 'user',
          args: '',
          allowedTools: [],
          allowedResourceRoots: [],
        },
        'Previously accepted guidance.',
        'older-turn',
      );
      await continuity.finish('older-turn', 'succeeded');
      const response = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/checked', kind: 'skill' }),
      });
      expect(response.status).toBe(202);
      const eventStream = Promise.resolve(app.request(`/sessions/${sessionId}/events`)).then(
        (response) => response.text(),
      );
      await Promise.race([
        entered,
        eventStream.then((events) => {
          throw new Error(`pre-query fault was not reached: ${events}`);
        }),
      ]);
      if (mode === 'cancel') {
        expect(
          (await app.request(`/sessions/${sessionId}/cancel`, { method: 'POST' })).status,
        ).toBe(200);
      }
      const events = await eventStream;
      expect(events).toContain('event: turn_error');
      expect(providerCalls).toBe(0);
      const records = await continuity.exportRecords();
      const outcome = mode === 'cancel' ? 'cancelled' : 'failed';
      expect(records.find((record) => record.name === 'checked')?.outcome).toBe(outcome);
      expect(records.find((record) => record.name === 'older')?.outcome).toBe('succeeded');
      expect(
        continuity
          .diagnostics()
          .filter((event) => event.name === 'checked' && event.code === outcome),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
}

test('SOV overflow recovery settles the logical skill lifetime after the successful child retry', async () => {
  const runtime = await buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    settings: {
      learning: { disabled: true, recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 } },
      review: { disabled: true },
    },
  });
  try {
    const wrapped = wrapTransportWithOverflow(
      runtime.resolvedProvider.transport,
      (call) => call === 1,
    );
    runtime.resolvedProvider.transport = wrapped.transport;
    const app = buildAppWithRuntime(runtime);
    const { sessionId } = (await (await app.request('/sessions', { method: 'POST' })).json()) as {
      sessionId: string;
    };
    const parent = runtime.getSessionContext(sessionId).skillContinuity;
    if (!parent) throw new Error('missing parent continuity');
    await parent.activated(
      {
        name: 'older',
        revision: 'a'.repeat(64),
        source: 'user',
        args: '',
        allowedTools: [],
        allowedResourceRoots: [],
      },
      'Previously failed guidance.',
      'older-turn',
    );
    await parent.finish('older-turn', 'failed');
    const filler = 'lorem ipsum dolor sit amet '.repeat(500);
    for (let index = 0; index < 3; index++) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: `prior ${index}: ${filler}` }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${index}: ${filler}` }],
      });
    }
    const response = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '/checked', kind: 'skill' }),
    });
    expect(response.status).toBe(202);
    const events = await (await app.request(`/sessions/${sessionId}/events`)).text();
    expect(events).toContain('event: turn_complete');
    expect(events).not.toContain('event: turn_error');
    expect(wrapped.callCounter()).toEqual({ mainCalls: 2, summarizeCalls: 1 });
    const children = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(children).toHaveLength(1);
    const childId = children[0]?.childSessionId;
    if (!childId) throw new Error('missing compaction child');
    const child = runtime.getSessionContext(childId).skillContinuity;
    if (!child) throw new Error('missing child continuity');
    for (const continuity of [parent, child]) {
      const records = await continuity.exportRecords();
      expect(records.find((record) => record.name === 'checked')?.outcome).toBe('succeeded');
      expect(records.find((record) => record.name === 'checked')?.guidance).toBe(
        'Keep the accepted workflow.',
      );
      expect(records.find((record) => record.name === 'older')?.outcome).toBe('failed');
      expect(
        continuity
          .diagnostics()
          .filter((event) => event.name === 'checked' && event.code === 'succeeded'),
      ).toHaveLength(1);
      expect(
        continuity
          .diagnostics()
          .some((event) => event.name === 'checked' && event.code === 'failed'),
      ).toBe(false);
    }
  } finally {
    await runtime.dispose();
  }
});
