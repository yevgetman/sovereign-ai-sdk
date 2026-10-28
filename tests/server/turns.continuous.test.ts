import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { z } from 'zod';
import { compressionSystemPrompt } from '../../src/compact/compactor.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';

function events(body: string): Record<string, unknown>[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
class ScriptProvider extends MockProvider {
  constructor(
    private readonly script: (
      request: ProviderRequest,
    ) => AssistantMessage | Promise<AssistantMessage>,
  ) {
    super();
  }
  override async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const message = await this.script(request);
    yield { type: 'message_start' };
    const tool = message.content.some((block) => block.type === 'tool_use');
    for (const block of message.content) {
      if (block.type === 'text') yield { type: 'text_delta', text: block.text };
    }
    yield { type: 'message_stop', stop_reason: tool ? 'tool_use' : 'end_turn' };
    yield { type: 'assistant_message', message };
    return message;
  }
}
function text(value: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: value }] };
}
async function begin(app: ReturnType<typeof buildAppWithRuntime>): Promise<string> {
  const created = await app.request('/sessions', { method: 'POST' });
  const { sessionId } = (await created.json()) as { sessionId: string };
  expect(
    (
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Complete the task.' }),
      })
    ).status,
  ).toBe(202);
  return sessionId;
}
async function drain(app: ReturnType<typeof buildAppWithRuntime>, sessionId: string) {
  return events(await (await app.request(`/sessions/${sessionId}/events`)).text());
}

describe('HTTP continuous owner turn', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-http-continuous-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetAllBuses();
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unset test-only environment switch.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    __test_resetAllBuses();
    rmSync(home, { recursive: true, force: true });
  });
  const boot = () =>
    buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
      proactiveCompactThreshold: 0.05,
    });

  test('1001 cursor pages survive repeated real compaction and emit one final', async () => {
    const runtime = await boot();
    let page = 0;
    let summaries = 0;
    let workCalls = 0;
    const pageTool = buildTool({
      name: 'Page',
      description: () => 'Read next page',
      inputSchema: z.object({ cursor: z.string() }),
      isReadOnly: () => true,
      async call(input) {
        expect(input.cursor).toBe(`cursor-${page}`);
        page++;
        return {
          data: { nextCursor: `cursor-${page}`, rows: [`page ${page}: ${'x'.repeat(1600)}`] },
        };
      },
    });
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      pageTool as unknown as Tool<unknown, unknown>,
    );
    runtime.resolvedProvider.transport = new ScriptProvider((request) => {
      if (request.system.some((segment) => segment.text === compressionSystemPrompt())) {
        summaries++;
        return text(`Completed ${page} pages. Continue with cursor-${page}.`);
      }
      workCalls++;
      if (page > 0) expect(JSON.stringify(request.messages)).toContain(`cursor-${page}`);
      return page === 1001
        ? text('All 1001 pages are complete.')
        : {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `page-${page}`,
                name: 'Page',
                input: { cursor: `cursor-${page}` },
              },
            ],
          };
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const sessionId = await begin(app);
      const wire = await drain(app, sessionId);
      expect(page).toBe(1001);
      expect(workCalls).toBe(1002);
      expect(summaries).toBeGreaterThan(1);
      expect(wire.filter((event) => event.type === 'compaction_complete').length).toBe(summaries);
      expect(wire.filter((event) => event.type === 'turn_complete')).toHaveLength(1);
      expect(wire.filter((event) => event.type === 'turn_error')).toHaveLength(0);
      expect(
        wire
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.text)
          .join(''),
      ).toContain('All 1001');
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  test('explicit HTTP authority includes calls delegated to a null-budget child', async () => {
    const runtime = await boot();
    runtime.ownerModelCallLimit = 2;
    let calls = 0;
    let childCalls = 0;
    const delegate = runtime.subagentScheduler.delegate.bind(runtime.subagentScheduler);
    runtime.subagentScheduler.delegate = async (input) => {
      const result = await delegate(input);
      childCalls += result.iterationsUsed;
      return result;
    };
    const child = runtime.agents.byName.get('explore');
    if (!child) throw new Error('built-in explore agent missing');
    expect(child.maxTurns).toBeNull();
    runtime.toolPool.splice(0, runtime.toolPool.length, AgentTool);
    runtime.resolvedProvider.transport = new ScriptProvider(() => {
      calls++;
      return {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'delegate-1',
            name: 'AgentTool',
            input: { subagent_type: 'explore', prompt: 'Give a brief answer.' },
          },
        ],
      };
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const wire = await drain(app, await begin(app));
      expect(calls).toBe(1);
      expect(childCalls).toBe(1);
      expect(wire.filter((event) => event.type === 'turn_error')).toHaveLength(1);
      expect(wire.filter((event) => event.type === 'turn_complete')).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('one-call authority forbids a paid overflow summary or retry', async () => {
    const runtime = await boot();
    runtime.ownerModelCallLimit = 1;
    let calls = 0;
    runtime.resolvedProvider.transport = new ScriptProvider(() => {
      calls++;
      throw new Error('context length exceeded by 12000 tokens');
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const wire = await drain(app, await begin(app));
      expect(calls).toBe(1);
      expect(wire.filter((event) => event.type === 'turn_error')).toHaveLength(1);
      expect(wire.filter((event) => event.type === 'turn_complete')).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('stop cancels the same live turn and emits exactly one terminal', async () => {
    const runtime = await boot();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    runtime.resolvedProvider.transport = new ScriptProvider(async (request) => {
      calls++;
      started();
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted) reject(request.signal.reason);
        else
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          });
      });
      return text('unexpected');
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const sessionId = await begin(app);
      await entered;
      const cancel = await app.request(`/sessions/${sessionId}/cancel`, { method: 'POST' });
      expect(await cancel.json()).toEqual({ cancelled: true });
      const wire = await drain(app, sessionId);
      expect(calls).toBe(1);
      expect(
        wire.filter((event) => event.type === 'turn_error' || event.type === 'turn_complete'),
      ).toHaveLength(1);
      expect(wire.filter((event) => event.type === 'text_delta')).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('unknown effect receipt blocks automatic continuation after a tool slice', async () => {
    const runtime = await boot();
    let calls = 0;
    const pageTool = buildTool({
      name: 'Page',
      description: () => 'Read next page',
      inputSchema: z.object({}),
      isReadOnly: () => true,
      async call(_input, context) {
        runtime.sessionDb.saveToolExecution(context.sessionId, {
          assistantMessageId: runtime.sessionDb.loadMessages(context.sessionId).at(-1)?.id ?? -1,
          toolUseId: 'unconfirmed-effect',
          state: 'unknown',
        });
        return { data: { nextCursor: 'page-2' } };
      },
    });
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      pageTool as unknown as Tool<unknown, unknown>,
    );
    runtime.resolvedProvider.transport = new ScriptProvider(() => {
      calls++;
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'page-1', name: 'Page', input: {} }],
      };
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const wire = await drain(app, await begin(app));
      expect(calls).toBe(1);
      expect(wire.filter((event) => event.type === 'turn_error')).toHaveLength(1);
      expect(wire.filter((event) => event.type === 'turn_complete')).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});
