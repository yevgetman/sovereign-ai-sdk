import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import { RouteError, getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { type SdkRunDependencies, runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const roots: string[] = [];
const captures: Record<string, unknown>[][] = [];
afterAll(() => {
  if (process.env.SDK_RECOVERY_WIRE_OUTPUT)
    writeFileSync(process.env.SDK_RECOVERY_WIRE_OUTPUT, JSON.stringify(captures));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const opts = { json: true, stdin: true, route: 'openai-api', inputFormat: 'json', toolset: 'chat' };
const message = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
function fixture(provider: LLMProvider, mutate?: (runtime: Runtime) => void) {
  const home = mkdtempSync(join(tmpdir(), 'sdk-run-recovery-'));
  roots.push(home);
  const db = join(home, 'sessions.db');
  const deps: SdkRunDependencies = {
    resolve: async () => ({
      route: getRoute('openai-api', {}),
      model: 'gpt-4.1',
      effort: 'off',
      provider,
      resolved: {
        transport: provider as Transport,
        client: provider,
        baseUrl: 'mock://',
        model: 'gpt-4.1',
        contextLength: 200000,
        authType: 'api_key',
        metadata: { provider: provider.name, apiMode: 'openai', purpose: 'main' },
      },
    }),
    runtime: async (options) => {
      const runtime = await buildRuntime({
        ...options,
        harnessHome: home,
        dbPath: db,
        settings: {
          learning: {
            disabled: true,
            recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
          },
          review: { disabled: true },
        },
        cronEnabled: false,
      });
      mutate?.(runtime);
      return runtime;
    },
  };
  return { db, deps };
}
function capture(onEvent?: (event: Record<string, unknown>) => void) {
  const events: Record<string, unknown>[] = [];
  captures.push(events);
  return {
    events,
    io: {
      readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'question' }),
      writeStdout: (line: string) => {
        const event = JSON.parse(line);
        events.push(event);
        onEvent?.(event);
      },
    },
  };
}
test('pre-session cancellation has no recoverable target', async () => {
  const controller = new AbortController();
  controller.abort();
  const c = capture();
  expect(
    await runSdkRunCommand(
      opts,
      { ...c.io, readStdin: async () => new Promise<string>(() => {}) },
      { signal: controller.signal },
    ),
  ).toBe(130);
  expect(c.events).toHaveLength(1);
  expect(Object.hasOwn(c.events[0] ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events[0]).toMatchObject({
    type: 'turn.error',
    outcome: 'interrupted',
    reason: 'cancelled',
    recoverable: false,
    sessionId: null,
    nextAction: 'retry',
  });
});

test('pre-session deadline is continuation_exhausted and not an interrupt', async () => {
  const c = capture();
  expect(
    await runSdkRunCommand(
      { ...opts, deadlineMs: 1 },
      { ...c.io, readStdin: async () => new Promise<string>(() => {}) },
    ),
  ).toBe(3);
  expect(c.events).toHaveLength(1);
  expect(Object.hasOwn(c.events[0] ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events[0]).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'deadline',
    code: 'continuation_exhausted',
    recoverable: false,
    sessionId: null,
    nextAction: 'none',
  });
  expect(c.events[0]?.outcome).not.toBe('interrupted');
  expect(c.events[0]?.code).not.toBe('cancelled');
  expect(c.events[0]?.code).not.toBe('interrupted');
  expect(c.events[0]?.nextAction).not.toBe('resume');
  expect(c.events[0]?.nextAction).not.toBe('continue_logical_turn');
});
for (const exhausted of ['max_tokens', 'max_turns'] as const) {
  test(`${exhausted} treats new transcript rows as progress until the model-call budget`, async () => {
    let calls = 0;
    let toolRuns = 0;
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        calls++;
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        yield {
          type: 'message_stop',
          stop_reason: exhausted === 'max_tokens' ? 'max_tokens' : 'tool_use',
        };
        const reply: AssistantMessage =
          exhausted === 'max_tokens'
            ? message('partial')
            : {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'refused', name: 'WebSearch', input: {} }],
              };
        yield { type: 'assistant_message', message: reply };
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.loop = { mode: 'off' };
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'WebSearch',
          description: () => 'fixture',
          inputSchema: z.unknown(),
          async call() {
            toolRuns++;
            return { data: 'receipt' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand(
        { ...opts, toolset: exhausted === 'max_turns' ? 'web' : 'chat' },
        c.io,
        f.deps,
      ),
    ).toBe(3);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'exhausted',
      reason: 'model_call_limit',
      code: 'continuation_exhausted',
      finishReason: 'model_call_limit',
      recoverable: false,
      nextAction: 'none',
    });
    expect(terminal?.finishReason).not.toBe('max_turns');
    expect(terminal?.finishReason).not.toBe('max_tokens');
    expect(terminal?.nextAction).not.toBe('continue_logical_turn');
    expect(terminal?.nextAction).not.toBe('resume');
    expect(c.events.filter((event) => event.type === 'turn.continuing').length).toBeGreaterThan(1);
    expect(c.events.some((event) => event.type === 'turn.completed')).toBe(false);
    const db = SessionDb.open({ path: f.db });
    try {
      expect(db.getSession(String(terminal?.activeSessionId))).not.toBeNull();
      expect(db.loadMessages(String(terminal?.activeSessionId)).length).toBeGreaterThan(1);
    } finally {
      db.close();
    }
    const callsAfterStop = calls;
    const toolsAfterStop = toolRuns;
    const logicalTurnId = String(terminal?.logicalTurnId);
    const continued = capture();
    expect(
      await runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        continued.io,
        f.deps,
      ),
    ).toBe(3);
    expect(calls).toBe(callsAfterStop);
    expect(toolRuns).toBe(toolsAfterStop);
    expect(continued.events.at(-1)).toMatchObject({
      type: 'turn.error',
      outcome: 'exhausted',
      code: 'continuation_exhausted',
      finishReason: 'model_call_limit',
      recoverable: false,
      nextAction: 'none',
      logicalTurnId,
    });
    expect(continued.events.at(-1)?.finishReason).not.toBe('max_turns');
    expect(continued.events.at(-1)?.finishReason).not.toBe('max_tokens');
    expect(continued.events.at(-1)?.outcome).not.toBe('interrupted');
    const after = SessionDb.open({ path: f.db });
    try {
      const stored = after.loadLogicalTurn(logicalTurnId);
      expect(stored?.status).toBe('exhausted');
      if (!stored) throw new Error('missing logical turn');
      stored.status = 'stalled';
      stored.finishReason = 'repeated:max_turns';
      after.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
        JSON.stringify(stored),
        logicalTurnId,
      ]);
    } finally {
      after.close();
    }
    const refused = capture();
    expect(
      await runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        refused.io,
        f.deps,
      ),
    ).toBe(3);
    expect(calls).toBe(callsAfterStop);
    expect(toolRuns).toBe(toolsAfterStop);
    expect(refused.events.at(-1)).toMatchObject({
      type: 'turn.error',
      outcome: 'stalled',
      code: 'continuation_stalled',
      finishReason: 'repeated:max_turns',
      recoverable: false,
      nextAction: 'none',
      logicalTurnId,
    });
    expect(refused.events.at(-1)?.nextAction).not.toBe('continue_logical_turn');
  });
}

test('model-call cap is not resumable and a follow-up continue does not call the model', async () => {
  let calls = 0;
  let toolRuns = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const id = `cap-${calls}`;
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      const reply: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'cap_probe', input: { n: calls } }],
      };
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.loop = { mode: 'off' };
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'cap_probe',
        description: () => 'cap fixture',
        inputSchema: z.unknown(),
        async call() {
          toolRuns++;
          return { data: `receipt-${toolRuns}` };
        },
      }),
    );
  });
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'coding' }, c.io, f.deps)).toBe(3);
  const terminal = c.events.at(-1);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'model_call_limit',
    code: 'continuation_exhausted',
    finishReason: 'model_call_limit',
    recoverable: false,
    nextAction: 'none',
  });
  expect(terminal?.finishReason).not.toBe('max_turns');
  expect(terminal?.finishReason).not.toBe('max_tokens');
  expect(terminal?.outcome).not.toBe('interrupted');
  expect(terminal?.nextAction).not.toBe('continue_logical_turn');
  expect(terminal?.nextAction).not.toBe('resume');
  // Host logicalModelCallLimit. One coding segment spends the whole budget.
  expect(calls).toBe(100);
  expect(toolRuns).toBe(100);
  const logicalTurnId = String(terminal?.logicalTurnId);
  const continued = capture();
  expect(
    await runSdkRunCommand(
      { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
      continued.io,
      f.deps,
    ),
  ).toBe(3);
  expect(calls).toBe(100);
  expect(toolRuns).toBe(100);
  expect(continued.events.some((event) => event.type === 'turn.continuing')).toBe(false);
  expect(continued.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'model_call_limit',
    code: 'continuation_exhausted',
    finishReason: 'model_call_limit',
    recoverable: false,
    nextAction: 'none',
    logicalTurnId,
  });
  expect(continued.events.at(-1)?.finishReason).not.toBe('max_turns');
  expect(continued.events.at(-1)?.outcome).not.toBe('interrupted');
  const after = SessionDb.open({ path: f.db });
  try {
    const stored = after.loadLogicalTurn(logicalTurnId);
    expect(stored?.status).toBe('exhausted');
    expect(stored?.finishReason).toBe('model_call_limit');
  } finally {
    after.close();
  }
});
for (const stage of ['post-session', 'mid-stream', 'after-final-event'] as const) {
  test(`cancellation ${stage} preserves only a verified durable session and usage once`, async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        if (stage === 'mid-stream') {
          controller.abort();
          throw new Error('fixture aborted');
        }
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: message('complete') };
        return message('complete');
      },
    };
    let usageWrites = 0;
    const f = fixture(provider, (runtime) => {
      const write = runtime.sessionDb.recordUsageEstimate.bind(runtime.sessionDb);
      runtime.sessionDb.recordUsageEstimate = (...args) => {
        usageWrites++;
        return write(...args);
      };
    });
    const c = capture((event) => {
      if (
        (stage === 'post-session' && event.type === 'session.started') ||
        (stage === 'after-final-event' && event.type === 'text_delta')
      )
        controller.abort();
    });
    expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(130);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'interrupted',
      recoverable: true,
      nextAction: 'resume',
    });
    const db = SessionDb.open({ path: f.db });
    try {
      const rows = db.loadMessages(String(terminal?.activeSessionId));
      expect(rows[0]?.role).toBe('user');
      if (stage === 'after-final-event')
        expect(rows.at(-1)?.content).toEqual(message('complete').content);
    } finally {
      db.close();
    }
    expect(usageWrites).toBe(stage === 'post-session' ? 0 : 1);
  });
}

test('continuing a cancelled logical turn does not call the model', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        controller.abort();
        throw new Error('fixture aborted');
      }
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider);
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, { ...f.deps, signal: controller.signal })).toBe(
    130,
  );
  const db = SessionDb.open({ path: f.db });
  let logicalTurnId = '';
  try {
    const rows = db.handle.query<{ record: string }, []>('SELECT record FROM logical_turns').all();
    expect(rows).toHaveLength(1);
    const record = JSON.parse(rows[0]?.record ?? '{}') as { logicalTurnId: string; status: string };
    logicalTurnId = record.logicalTurnId;
    expect(record.status).toBe('cancelled');
  } finally {
    db.close();
  }
  const second = capture();
  expect(
    await runSdkRunCommand(
      { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
      second.io,
      f.deps,
    ),
  ).toBe(3);
  expect(calls).toBe(1);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    logicalTurnId,
  });
  const nextAction = second.events.at(-1)?.nextAction;
  expect(nextAction).not.toBe('resume');
  expect(nextAction).not.toBe('continue_logical_turn');
});

test('a held lease refuses continuation without a provider call or stored-row change', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('durable answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider);
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, f.deps)).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const sessionId = String(first.events.at(-1)?.sessionId);
  const db = SessionDb.open({ path: f.db });
  let storedBefore = '';
  let messagesBefore = '';
  try {
    const row = db.handle
      .query<{ record: string }, [string]>(
        'SELECT record FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(logicalTurnId);
    const record = JSON.parse(row?.record ?? '{}') as { status: string };
    record.status = 'running';
    db.handle.run(
      `UPDATE logical_turns SET record = ?, lease_owner = ?, lease_expires_at = ?
       WHERE logical_turn_id = ?`,
      [JSON.stringify(record), 'other-owner', Date.now() + 30_000, logicalTurnId],
    );
    storedBefore = JSON.stringify(
      db.handle
        .query<
          { record: string; lease_owner: string | null; lease_expires_at: number | null },
          [string]
        >(
          'SELECT record, lease_owner, lease_expires_at FROM logical_turns WHERE logical_turn_id = ?',
        )
        .get(logicalTurnId),
    );
    messagesBefore = JSON.stringify(db.loadMessages(sessionId));
  } finally {
    db.close();
  }
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  expect(calls).toBe(1);
  const terminal = second.events.at(-1);
  expect(terminal?.code).not.toBe('provider_failed');
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'logical_turn_leased',
    recoverable: false,
    logicalTurnId,
    nextAction: 'none',
  });
  expect(String(terminal?.error)).toContain('owned elsewhere');
  expect(String(terminal?.error)).not.toContain('provider failed');
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(exitCode).toBe(3);
  const after = SessionDb.open({ path: f.db });
  try {
    expect(
      JSON.stringify(
        after.handle
          .query<
            { record: string; lease_owner: string | null; lease_expires_at: number | null },
            [string]
          >(
            'SELECT record, lease_owner, lease_expires_at FROM logical_turns WHERE logical_turn_id = ?',
          )
          .get(logicalTurnId),
      ),
    ).toBe(storedBefore);
    expect(JSON.stringify(after.loadMessages(sessionId))).toBe(messagesBefore);
  } finally {
    after.close();
  }
});

test('an uncooperative cancelled provider never advertises recovery', async () => {
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      controller.abort();
      await new Promise<void>(() => {});
      return message('never');
    },
  };
  const f = fixture(provider);
  const c = capture();
  const started = Date.now();
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(130);
  expect(Date.now() - started).toBeLessThan(4000);
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    recoverable: false,
    sessionId: null,
  });
});

test('a requested nonexistent resume id is refused without creating a recovery target', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      return message('never');
    },
  };
  const f = fixture(provider);
  const runtime = f.deps.runtime;
  // Test the native boundary even if an injected runtime skips boot validation.
  f.deps.runtime = (options) => {
    const { resumeId: _ignored, ...fresh } = options;
    return runtime?.(fresh) as Promise<Runtime>;
  };
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, resume: 'missing-session' }, c.io, f.deps)).toBe(2);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'invalid_input',
    recoverable: false,
    sessionId: null,
  });
  expect(calls).toBe(0);
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

test('completed tool receipt survives post-tool cancellation and is not replayed on resume', async () => {
  let effects = 0;
  let rounds = 0;
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      const reply: AssistantMessage =
        rounds++ === 0
          ? {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'effect', name: 'receipt_probe', input: {} }],
            }
          : message('finished');
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'receipt_probe',
        description: () => 'fixture receipt',
        inputSchema: z.object({}),
        async call() {
          effects++;
          return { data: 'effect done' };
        },
      }),
    );
  });
  const c = capture((event) => {
    if (event.type === 'tool_result') controller.abort();
  });
  expect(
    await runSdkRunCommand({ ...opts, toolset: 'coding' }, c.io, {
      ...f.deps,
      signal: controller.signal,
    }),
  ).toBe(130);
  const terminal = c.events.at(-1);
  expect(terminal).toMatchObject({ type: 'turn.error', recoverable: true, nextAction: 'resume' });
  const resumed = capture();
  expect(
    await runSdkRunCommand(
      { ...opts, toolset: 'coding', resume: String(terminal?.activeSessionId) },
      resumed.io,
      f.deps,
    ),
  ).toBe(0);
  expect(resumed.events.at(-1)).toMatchObject({
    type: 'turn.completed',
    outcome: 'completed',
    finishReason: 'end_turn',
  });
  expect(effects).toBe(1);
});

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener('abort', () => resolve(), { once: true }),
  );
}
for (const stage of [
  'post-session',
  'mid-stream',
  'mid-tool',
  'post-tool',
  'after-final-event',
] as const) {
  test(`deadline ${stage} reports its cause and only durable recovery`, async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'openai',
      async *stream(request) {
        calls++;
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        if (stage === 'mid-stream') {
          await waitForAbort(request.signal);
          throw new Error('fixture timeout');
        }
        const reply: AssistantMessage =
          (stage === 'mid-tool' || stage === 'post-tool') && calls === 1
            ? {
                role: 'assistant',
                content: [
                  { type: 'tool_use', id: 'deadline-effect', name: 'deadline_probe', input: {} },
                ],
              }
            : message('complete');
        yield {
          type: 'message_stop',
          stop_reason:
            calls === 1 && (stage === 'mid-tool' || stage === 'post-tool')
              ? 'tool_use'
              : 'end_turn',
        };
        yield { type: 'assistant_message', message: reply };
        if (stage === 'after-final-event') await waitForAbort(request.signal);
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      if (stage === 'post-session' || stage === 'post-tool')
        runtime.hookRunner = async (event, _payload, signal) => {
          if (
            (stage === 'post-session' && event === 'UserPromptSubmit') ||
            (stage === 'post-tool' && event === 'PostToolUse')
          )
            await waitForAbort(signal);
          return { block: false };
        };
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'deadline_probe',
          description: () => 'deadline fixture',
          inputSchema: z.unknown(),
          async call(_input, context) {
            if (stage === 'mid-tool') await waitForAbort(context.signal);
            return { data: 'safe receipt' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand({ ...opts, toolset: 'coding', deadlineMs: 1000 }, c.io, f.deps),
    ).toBe(3);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'exhausted',
      reason: 'deadline',
      code: 'continuation_exhausted',
      recoverable: false,
      nextAction: 'none',
    });
    expect(terminal?.outcome).not.toBe('interrupted');
    expect(terminal?.code).not.toBe('cancelled');
    expect(terminal?.code).not.toBe('interrupted');
    expect(terminal?.nextAction).not.toBe('resume');
    expect(terminal?.nextAction).not.toBe('continue_logical_turn');
    expect(typeof terminal?.logicalTurnId).toBe('string');
    const db = SessionDb.open({ path: f.db });
    try {
      const stored = db.loadLogicalTurn(String(terminal?.logicalTurnId));
      expect(stored?.status).toBe('exhausted');
      expect(stored?.finishReason).toBe('deadline');
      expect(stored?.status).not.toBe('running');
      expect(stored?.status).not.toBe('cancelled');
    } finally {
      db.close();
    }
    if (stage === 'post-session') expect(calls).toBe(0);
    if (stage === 'mid-stream') {
      expect(calls).toBe(1);
      const continued = capture();
      expect(
        await runSdkRunCommand(
          {
            json: true,
            sdk: true,
            db: f.db,
            continueLogicalTurn: String(terminal?.logicalTurnId),
          },
          continued.io,
          f.deps,
        ),
      ).toBe(3);
      expect(calls).toBe(1);
      expect(continued.events.at(-1)).toMatchObject({
        type: 'turn.error',
        outcome: 'exhausted',
        reason: 'deadline',
        code: 'continuation_exhausted',
        finishReason: 'deadline',
        recoverable: false,
        nextAction: 'none',
      });
      expect(continued.events.at(-1)?.outcome).not.toBe('interrupted');
      expect(continued.events.at(-1)?.nextAction).not.toBe('resume');
      expect(continued.events.at(-1)?.nextAction).not.toBe('continue_logical_turn');
    }
  });
}

test('a usage storage failure during cancellation disables recovery and keeps errors secret-safe', async () => {
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      controller.abort();
      throw new Error('fixture aborted');
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.sessionDb.recordUsageEstimate = () => {
      throw new Error('private usage store failure');
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'failed',
    code: 'storage_failed',
    recoverable: false,
    nextAction: 'inspect_storage',
  });
  expect(JSON.stringify(c.events)).not.toContain('private usage store failure');
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

for (const cooperative of [true, false]) {
  test(`mid-tool cancellation ${cooperative ? 'settles its receipt' : 'refuses unknown effects'}`, async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        const reply: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'mid-effect', name: 'mid_tool_probe', input: {} }],
        };
        yield { type: 'message_start' };
        yield { type: 'assistant_message', message: reply };
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'mid_tool_probe',
          description: () => 'mid-tool fixture',
          inputSchema: z.unknown(),
          async call(_input, context) {
            controller.abort();
            if (!cooperative) await new Promise<void>(() => {});
            await waitForAbort(context.signal);
            return { data: 'settled safe effect' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand({ ...opts, toolset: 'coding' }, c.io, {
        ...f.deps,
        signal: controller.signal,
      }),
    ).toBe(130);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({ type: 'turn.error', outcome: 'interrupted' });
    if (cooperative) expect(terminal?.recoverable).toBe(true);
    else {
      expect(terminal?.recoverable).toBe(false);
      expect(Object.hasOwn(terminal ?? {}, 'activeSessionId')).toBe(false);
    }
  });
}

test('late cancelled transcript storage failure never duplicates the canonical assistant or exposes recovery', async () => {
  const controller = new AbortController();
  let failed = false;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'partial' };
      yield { type: 'assistant_message', message: message('complete') };
      return message('complete');
    },
  };
  const f = fixture(provider, (runtime) => {
    const transcript = runtime.transcripts;
    if (!transcript) throw new Error('fixture requires transcripts');
    const record = transcript.recordMessage.bind(transcript);
    transcript.recordMessage = (...args) => {
      if (args[1] === 'assistant' && !failed) {
        failed = true;
        throw new Error('private transcript failure');
      }
      record(...args);
    };
  });
  const c = capture((event) => {
    if (event.type === 'text_delta') controller.abort();
  });
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'storage_failed',
    recoverable: false,
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  const id = String(c.events.find((event) => event.type === 'session.started')?.sessionId);
  const db = SessionDb.open({ path: f.db });
  try {
    expect(db.loadMessages(id).map((row) => row.role)).toEqual(['user', 'assistant']);
  } finally {
    db.close();
  }
  expect(JSON.stringify(c.events)).not.toContain('private transcript failure');
});

test('a final storage verification fault cannot report completed success or lose completed rows/usage', async () => {
  let failReads = false;
  let usageWrites = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: message('complete') };
      return message('complete');
    },
  };
  const f = fixture(provider, (runtime) => {
    const get = runtime.sessionDb.getSession.bind(runtime.sessionDb);
    runtime.sessionDb.getSession = (...args) => {
      if (failReads) throw new Error('private final store verification failure');
      return get(...args);
    };
    const write = runtime.sessionDb.recordUsageEstimate.bind(runtime.sessionDb);
    runtime.sessionDb.recordUsageEstimate = (...args) => {
      const value = write(...args);
      usageWrites++;
      failReads = true;
      return value;
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'failed',
    code: 'storage_failed',
    recoverable: false,
    nextAction: 'inspect_storage',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events.some((event) => event.type === 'turn.completed')).toBe(false);
  expect(usageWrites).toBe(1);
  const id = String(c.events.find((event) => event.type === 'session.started')?.sessionId);
  const db = SessionDb.open({ path: f.db });
  try {
    expect(db.loadMessages(id).map((row) => row.role)).toEqual(['user', 'assistant']);
  } finally {
    db.close();
  }
  expect(JSON.stringify(c.events)).not.toContain('private final store verification failure');
});

test('actual native checkin wire completes as waiting_user', async () => {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/sdk-run-checkin.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(errors).not.toContain('error:');
  const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
  captures.push(result.events);
  expect(result.exit).toBe(0);
  expect(result.events.at(-1)).toMatchObject({
    type: 'turn.completed',
    outcome: 'waiting_user',
    reason: 'checkin',
    nextAction: 'user_input',
  });
  expect(result.effects).toBe(1);
  expect(result.rows).toEqual(['user', 'assistant', 'user']);
});

test('pre-session rate limit requests retry without claiming a nonexistent recovery target', async () => {
  const c = capture();
  expect(
    await runSdkRunCommand(opts, c.io, {
      resolve: async () => {
        throw new RouteError('rate_limited', 'mock transient limit');
      },
    }),
  ).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'rate_limited',
    recoverable: false,
    sessionId: null,
    nextAction: 'retry',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

// The separate #73 route mapper introduces this stable token-service code.
// Inject that future typed route outcome here without importing its branch.
test('pre-session malformed token response requests provider inspection rather than automatic retry', async () => {
  const c = capture();
  expect(
    await runSdkRunCommand(opts, c.io, {
      resolve: async () => {
        const error = new RouteError('rate_limited', 'mock malformed token response');
        Object.defineProperty(error, 'code', { value: 'provider_response_invalid' });
        throw error;
      },
    }),
  ).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'provider_response_invalid',
    recoverable: false,
    sessionId: null,
    nextAction: 'check_provider',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

const CONTINUATION_TEXT =
  'Continue the interrupted answer without repeating text already saved. Do not start a new task.';

function rolesAlternate(roles: readonly string[]): boolean {
  return roles.every((role, index) => index === 0 || role !== roles[index - 1]);
}

test('max_tokens on text keeps one hidden runtime marker and does not replay the prompt', async () => {
  const seen: Message[][] = [];
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req) {
      calls++;
      seen.push(structuredClone(req.messages));
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      if (calls === 1) {
        yield { type: 'message_stop', stop_reason: 'max_tokens' };
        const reply = message('partial');
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const reply = message('done');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.loop = { mode: 'off' };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(0);
  expect(calls).toBe(2);
  expect(c.events.filter((event) => event.type === 'turn.continuing')).toHaveLength(1);
  const terminal = c.events.at(-1);
  expect(terminal).toMatchObject({ type: 'turn.completed', outcome: 'completed' });
  const logicalTurnId = String(terminal?.logicalTurnId);
  const continued = seen[1] ?? [];
  expect(continued.map((row) => row.role)).toEqual(['user', 'assistant', 'user']);
  expect(rolesAlternate(continued.map((row) => row.role))).toBe(true);
  const markers = continued.filter((row) => row.role === 'user' && row.origin === 'runtime');
  expect(markers).toHaveLength(1);
  expect(markers[0]).toMatchObject({
    origin: 'runtime',
    id: `${logicalTurnId}:output:1`,
    content: [{ type: 'text', text: CONTINUATION_TEXT }],
  });
  expect(
    continued.filter(
      (row) =>
        row.role === 'user' &&
        row.origin !== 'runtime' &&
        row.content.some((block) => block.type === 'text' && block.text.includes('question')),
    ),
  ).toHaveLength(1);
  const db = SessionDb.open({ path: f.db });
  try {
    const stored = db.loadMessages(String(terminal?.activeSessionId));
    const storedMarkers = stored.filter(
      (row) =>
        row.toolCalls !== null &&
        typeof row.toolCalls === 'object' &&
        (row.toolCalls as { origin?: unknown }).origin === 'runtime',
    );
    expect(storedMarkers).toHaveLength(1);
    expect(storedMarkers[0]?.toolCallId).toBe(`${logicalTurnId}:output:1`);
    expect(stored.map((row) => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rolesAlternate(stored.map((row) => row.role))).toBe(true);
    expect(
      stored.filter((row) =>
        row.content.some((block) => block.type === 'text' && block.text === 'question'),
      ),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('max_tokens on tool_use stops instead of guessing a second user row', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'message_stop', stop_reason: 'max_tokens' };
      const reply: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'truncated', name: 'WebSearch', input: {} }],
      };
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.loop = { mode: 'off' };
  });
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'web' }, c.io, f.deps)).toBe(3);
  expect(calls).toBe(1);
  expect(c.events.filter((event) => event.type === 'turn.continuing')).toHaveLength(0);
  const terminal = c.events.at(-1);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_unsafe',
    recoverable: false,
    nextAction: 'inspect_session',
  });
  expect(terminal?.nextAction).not.toBe('continue_logical_turn');
  expect(terminal?.finishReason).not.toBe('max_tokens');
  const db = SessionDb.open({ path: f.db });
  try {
    const stored = db.loadMessages(String(terminal?.activeSessionId));
    expect(rolesAlternate(stored.map((row) => row.role))).toBe(true);
    expect(stored.filter((row) => row.role === 'user')).toHaveLength(2);
    expect(
      stored.some((row) =>
        row.content.some((block) => block.type === 'text' && block.text === CONTINUATION_TEXT),
      ),
    ).toBe(false);
    expect(
      stored.some(
        (row) =>
          row.toolCalls !== null &&
          typeof row.toolCalls === 'object' &&
          (row.toolCalls as { origin?: unknown }).origin === 'runtime',
      ),
    ).toBe(false);
    const tail = stored.at(-1);
    expect(tail?.role).toBe('user');
    expect(tail?.content.some((block) => block.type === 'tool_result')).toBe(true);
  } finally {
    db.close();
  }
});
