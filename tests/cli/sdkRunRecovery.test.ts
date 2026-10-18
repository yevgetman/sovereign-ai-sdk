import { afterAll, afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogicalTurnBinding } from '@yevgetman/sov-sdk/agent/logicalTurn';
import { AMBIGUOUS_MAX_TOKENS_TOOL_NOTE } from '@yevgetman/sov-sdk/core/query';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import { buildHookRunner } from '@yevgetman/sov-sdk/hooks/runner';
import { FENCE_PREAMBLE, formatMemorySnapshot } from '@yevgetman/sov-sdk/memory/injection';
import { SessionPersistenceError } from '@yevgetman/sov-sdk/providers/errors';
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
const CORRUPT_ROW_ERROR = 'Logical turn recovery state is invalid.';
const PINNED_ENVIRONMENT_ERROR =
  'The continue will not proceed until the process is in the pinned environment.';

function pinnedMismatchError(kind: string): string {
  return `Logical turn ${kind}. ${PINNED_ENVIRONMENT_ERROR}`;
}
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
  return { home, db, deps };
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
  expect(String(c.events[0]?.error)).toMatch(/deadline/i);
  expect(String(c.events[0]?.error)).not.toContain('cumulative recovery budget');
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
  expect(terminal?.error).toBe('Logical turn exhausted its cumulative recovery budget.');
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
    nextAction: 'none',
    logicalTurnId,
  });
  const terminal = second.events.at(-1);
  expect(String(terminal?.error)).toMatch(/cancell?ed/i);
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.nextAction).not.toBe('resume');
  expect(terminal?.nextAction).not.toBe('continue_logical_turn');
});

test('a held lease waits to continue the same turn without a provider call or stored-row change', async () => {
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
  const leaseExpiresAt = Date.now() + 20_000;
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
      [JSON.stringify(record), 'other-owner', leaseExpiresAt, logicalTurnId],
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
  const commandStarted = Date.now();
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  const commandFinished = Date.now();
  expect(calls).toBe(1);
  expect(second.events.some((event) => event.type === 'tool_use_start')).toBe(false);
  const terminal = second.events.at(-1);
  expect(terminal?.code).not.toBe('provider_failed');
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'logical_turn_leased',
    recoverable: true,
    logicalTurnId,
    nextAction: 'continue_logical_turn',
  });
  const retryAfterMs = terminal?.retryAfterMs;
  expect(typeof retryAfterMs).toBe('number');
  if (typeof retryAfterMs !== 'number') throw new Error('retryAfterMs missing');
  expect(retryAfterMs).toBeGreaterThan(0);
  expect(retryAfterMs).toBeGreaterThanOrEqual(leaseExpiresAt - commandFinished);
  expect(retryAfterMs).toBeLessThanOrEqual(leaseExpiresAt - commandStarted + 1);
  expect(String(terminal?.error)).toContain('live owner');
  expect(String(terminal?.error)).toContain('crashed owner');
  expect(String(terminal?.error)).toContain('lease expires');
  expect(String(terminal?.error)).not.toContain('provider failed');
  expect(terminal?.nextAction).not.toBe('none');
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

test('an expired lease accepts the same logical turn when receipts are safe', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message(calls === 1 ? 'durable answer' : 'continued answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider);
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, f.deps)).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'running';
    db.handle.run(
      `UPDATE logical_turns SET record = ?, lease_owner = ?, lease_expires_at = ?
       WHERE logical_turn_id = ?`,
      [JSON.stringify(record), 'crashed-owner', Date.now() - 1, logicalTurnId],
    );
  } finally {
    db.close();
  }
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  expect(calls).toBe(2);
  expect(exitCode).toBe(0);
  const terminal = second.events.at(-1);
  expect(terminal?.code).not.toBe('logical_turn_leased');
  expect(terminal).toMatchObject({
    type: 'turn.completed',
    logicalTurnId,
    reply: 'continued answer',
  });
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
    expect(String(terminal?.error)).toMatch(/deadline/i);
    expect(String(terminal?.error)).not.toContain('cumulative recovery budget');
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
      expect(String(continued.events.at(-1)?.error)).toMatch(/deadline/i);
      expect(String(continued.events.at(-1)?.error)).not.toContain('cumulative recovery budget');
    }
  });
}

test('deadline during a segment runs the Stop command once', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      calls += 1;
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      await waitForAbort(request.signal);
      throw new Error('fixture timeout');
    },
  };
  const f = fixture(provider, (runtime) => {
    const marker = join(f.home, 'stops.txt');
    const script = join(f.home, 'stop.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\n`);
    chmodSync(script, 0o755);
    runtime.hookRunner = buildHookRunner({
      hooksByEvent: {
        PreToolUse: [],
        PostToolUse: [],
        UserPromptSubmit: [],
        Stop: [{ hooks: [{ type: 'command', command: script }] }],
      },
      consent: async () => 'allow',
      logStderr: () => {},
    });
  });
  const marker = join(f.home, 'stops.txt');
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'chat', deadlineMs: 1500 }, c.io, f.deps)).toBe(
    3,
  );
  expect(calls).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'deadline',
    code: 'continuation_exhausted',
  });
  expect(
    readFileSync(marker, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ).toEqual(['ran']);
});

test('resumed work aborts a blocking tool at the stored deadline', async () => {
  let calls = 0;
  let toolRuns = 0;
  let toolStartedAt = 0;
  let toolAbortedAt = 0;
  let toolReason: unknown;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      if (calls === 1) {
        const reply = message('durable answer');
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      if (calls > 2) {
        const reply = message('model call after the stored deadline');
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      const reply: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'stored-deadline', name: 'deadline_probe', input: {} }],
      };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'deadline_probe',
        description: () => 'stored deadline fixture',
        inputSchema: z.unknown(),
        async call(_input, context) {
          toolRuns++;
          toolStartedAt = Date.now();
          // A late return is the overrun the resume timer must prevent.
          await Promise.race([
            waitForAbort(context.signal),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);
          toolAbortedAt = Date.now();
          toolReason = context.signal?.reason;
          if (context.signal?.aborted !== true) return { data: 'overran the stored deadline' };
          return { data: 'aborted at the stored deadline' };
        },
      }),
    );
  });
  const first = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'coding' }, first.io, f.deps)).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const deadlineAt = Date.now() + 2500;
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'running';
    record.deadlineAt = deadlineAt;
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
  } finally {
    db.close();
  }
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  expect(toolRuns).toBe(1);
  expect(toolStartedAt).toBeLessThanOrEqual(deadlineAt);
  expect(toolReason).toBe('deadline');
  expect(toolAbortedAt).toBeGreaterThanOrEqual(deadlineAt - 250);
  expect(toolAbortedAt).toBeLessThanOrEqual(deadlineAt + 1000);
  expect(calls).toBe(2);
  expect(JSON.stringify(second.events)).not.toContain('overran the stored deadline');
  expect(JSON.stringify(second.events)).not.toContain('model call after the stored deadline');
  expect(exitCode).toBe(3);
  const terminal = second.events.at(-1);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'deadline',
    code: 'continuation_exhausted',
    finishReason: 'deadline',
    recoverable: false,
    nextAction: 'none',
    logicalTurnId,
  });
  expect(terminal?.outcome).not.toBe('interrupted');
  expect(terminal?.nextAction).not.toBe('continue_logical_turn');
  expect(terminal?.nextAction).not.toBe('resume');
  const stored = SessionDb.open({ path: f.db });
  try {
    const record = stored.loadLogicalTurn(logicalTurnId);
    expect(record?.status).toBe('exhausted');
    expect(record?.finishReason).toBe('deadline');
    expect(record?.deadlineAt).toBe(deadlineAt);
  } finally {
    stored.close();
  }
});

function isSummaryRequest(system: ReadonlyArray<{ text?: string }>): boolean {
  return system.some((segment) =>
    segment.text?.includes('compressing an agent harness conversation'),
  );
}

function appendReducibleHistory(dbPath: string, sessionId: string): void {
  const db = SessionDb.open({ path: dbPath });
  try {
    for (let i = 0; i < 10; i++)
      db.saveMessage(sessionId, {
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `history-${i} ${'a'.repeat(2000)}` }],
      });
  } finally {
    db.close();
  }
}

function markRunningAtDeadline(dbPath: string, logicalTurnId: string, deadlineAt: number): void {
  const db = SessionDb.open({ path: dbPath });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'running';
    record.deadlineAt = deadlineAt;
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
  } finally {
    db.close();
  }
}

test('a past stored deadline does not run resumed compaction', async () => {
  let summaries = 0;
  let mains = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      if (isSummaryRequest(request.system)) {
        summaries++;
        const reply = message('summary after the stored deadline');
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      mains++;
      const reply = message('durable answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.proactiveCompactThreshold = 0;
  });
  const first = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'coding' }, first.io, f.deps)).toBe(0);
  expect(summaries).toBe(0);
  expect(mains).toBe(1);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const sessionId = String(first.events.at(-1)?.activeSessionId);
  appendReducibleHistory(f.db, sessionId);
  const deadlineAt = Date.now() - 1000;
  markRunningAtDeadline(f.db, logicalTurnId, deadlineAt);
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  expect(summaries).toBe(0);
  expect(mains).toBe(1);
  expect(exitCode).toBe(3);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'deadline',
    code: 'continuation_exhausted',
    logicalTurnId,
  });
  const stored = SessionDb.open({ path: f.db });
  try {
    const record = stored.loadLogicalTurn(logicalTurnId);
    expect(record?.status).toBe('exhausted');
    expect(record?.finishReason).toBe('deadline');
    expect(record?.deadlineAt).toBe(deadlineAt);
  } finally {
    stored.close();
  }
});

test('a stored deadline aborts compaction that is still running', async () => {
  let summaries = 0;
  let mains = 0;
  let summaryAborted = false;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      if (isSummaryRequest(request.system)) {
        summaries++;
        summaryAborted = await Promise.race([
          waitForAbort(request.signal).then(() => request.signal?.reason === 'deadline'),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!summaryAborted) {
          const reply = message('summary finished after the stored deadline');
          yield { type: 'assistant_message', message: reply };
          return reply;
        }
        throw new Error('summary aborted at the stored deadline');
      }
      mains++;
      const reply = message(
        mains === 1 ? 'durable answer' : 'model call after the stored deadline',
      );
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.proactiveCompactThreshold = 0;
  });
  const first = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'coding' }, first.io, f.deps)).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const sessionId = String(first.events.at(-1)?.activeSessionId);
  appendReducibleHistory(f.db, sessionId);
  const deadlineAt = Date.now() + 1500;
  markRunningAtDeadline(f.db, logicalTurnId, deadlineAt);
  const second = capture();
  const exitCode = await runSdkRunCommand(
    { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
    second.io,
    f.deps,
  );
  expect(summaries).toBe(1);
  expect(summaryAborted).toBe(true);
  expect(mains).toBe(1);
  expect(JSON.stringify(second.events)).not.toContain('model call after the stored deadline');
  expect(JSON.stringify(second.events)).not.toContain('summary finished after the stored deadline');
  expect(exitCode).toBe(3);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'exhausted',
    reason: 'deadline',
    code: 'continuation_exhausted',
    logicalTurnId,
  });
  const stored = SessionDb.open({ path: f.db });
  try {
    const record = stored.loadLogicalTurn(logicalTurnId);
    expect(record?.status).toBe('exhausted');
    expect(record?.deadlineAt).toBe(deadlineAt);
  } finally {
    stored.close();
  }
});

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
  expect(String(result.events.at(-1)?.answerWith)).toContain('--resume');
  expect(result.calls).toBe(1);
  expect(result.continueExit).toBe(0);
  expect(result.continueCalls).toBe(1);
  expect(String(result.continued.at(-1)?.answerWith)).toContain('--resume');
  expect(result.pipedExit).not.toBe(0);
  expect(result.continueCallsAfterPiped).toBe(1);
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

test('a segment boundary loads the transcript once', async () => {
  let calls = 0;
  const stacks: string[] = [];
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 1 } };
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
    const db = runtime.sessionDb;
    const loadMessages = db.loadMessages.bind(db);
    const loadToolExecutions = db.loadToolExecutions.bind(db);
    const note = (kind: string) => {
      stacks.push(`${kind} ${new Error().stack ?? ''}`);
    };
    db.loadMessages = (id: string) => {
      note('messages');
      return loadMessages(id);
    };
    db.loadToolExecutions = (id: string) => {
      note('receipts');
      return loadToolExecutions(id);
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(0);
  expect(calls).toBe(2);
  const boundary = stacks.filter(
    (stack) =>
      stack.includes('at recoverySafe') ||
      stack.includes('at progressSnapshot') ||
      stack.includes('at persistRuntimeContinuation') ||
      (stack.includes('at hydrate') && stack.includes('superviseLogicalTurn')) ||
      (stack.includes('at loadStoredMessages') && stack.includes('superviseLogicalTurn')) ||
      (stack.includes('at hasNativeRecoveryTarget') && stack.includes('superviseLogicalTurn')) ||
      (stack.includes('at ambiguousTruncatedToolRequest') &&
        stack.includes('superviseLogicalTurn')) ||
      stack.includes('at loadBoundary') ||
      stack.includes('at readBoundary'),
  );
  expect(boundary.filter((stack) => stack.startsWith('messages'))).toHaveLength(1);
  expect(boundary.filter((stack) => stack.startsWith('receipts'))).toHaveLength(1);
  const terminal = c.events.at(-1);
  const db = SessionDb.open({ path: f.db });
  try {
    const stored = db.loadMessages(String(terminal?.activeSessionId));
    expect(
      stored.some(
        (row) =>
          row.toolCalls !== null &&
          typeof row.toolCalls === 'object' &&
          (row.toolCalls as { origin?: unknown }).origin === 'runtime',
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

function answerProvider(): LLMProvider {
  return {
    name: 'openai',
    async *stream() {
      const reply = message('durable answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
}

async function inDirectory<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function withHarness<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HARNESS_HOME;
  const previousConfig = process.env.HARNESS_CONFIG;
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_CONFIG = join(home, 'config.json');
  try {
    return await run();
  } finally {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
    else process.env.HARNESS_HOME = previousHome;
    if (previousConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = previousConfig;
  }
}

test('a chat logical turn does not store a segment-count limit', async () => {
  const f = fixture(answerProvider());
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(0);
  const logicalTurnId = String(c.events.at(-1)?.logicalTurnId);
  const raw = JSON.parse(logicalTurnRecord(f.db, logicalTurnId)) as {
    segmentLimit?: unknown;
    logicalModelCallLimit?: unknown;
    counters?: { segments?: number };
  };
  expect(raw.logicalModelCallLimit).toBe(100);
  expect(raw.segmentLimit).toBeUndefined();
  expect(raw.counters?.segments).toBe(1);
});

function storedLogicalTurn(
  path: string,
  id: string,
): { record: NonNullable<ReturnType<SessionDb['loadLogicalTurn']>>; leaseOwner: string | null } {
  const db = SessionDb.open({ path });
  try {
    const row = db.handle
      .query<{ lease_owner: string | null }, [string]>(
        'SELECT lease_owner FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(id);
    const record = db.loadLogicalTurn(id);
    if (!record || !row) throw new Error('logical turn row missing');
    return { record, leaseOwner: row.lease_owner };
  } finally {
    db.close();
  }
}

function logicalTurnRecord(path: string, id: string): string {
  const db = SessionDb.open({ path });
  try {
    const row = db.handle
      .query<{ record: string }, [string]>(
        'SELECT record FROM logical_turns WHERE logical_turn_id = ?',
      )
      .get(id);
    expect(db.loadLogicalTurn(id)?.logicalTurnId).toBe(id);
    if (!row?.record) throw new Error('logical turn row missing');
    return row.record;
  } finally {
    db.close();
  }
}

function rewriteLogicalTurnBinding(
  path: string,
  id: string,
  edit: (binding: LogicalTurnBinding) => LogicalTurnBinding,
): void {
  const db = SessionDb.open({ path });
  try {
    const record = db.loadLogicalTurn(id);
    if (!record) throw new Error('logical turn row missing');
    record.binding = edit(record.binding);
    record.bindingDigest = bindingDigest(record.binding);
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      id,
    ]);
  } finally {
    db.close();
  }
}

test('continuing the same id from another cwd names the working-directory mismatch', async () => {
  const f = fixture(answerProvider());
  mkdirSync(join(f.home, 'origin'));
  mkdirSync(join(f.home, 'elsewhere'));
  const origin = realpathSync(join(f.home, 'origin'));
  const elsewhere = realpathSync(join(f.home, 'elsewhere'));
  const first = capture();
  expect(await inDirectory(origin, () => runSdkRunCommand(opts, first.io, f.deps))).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const stored = logicalTurnRecord(f.db, logicalTurnId);
  const second = capture();
  expect(
    await inDirectory(elsewhere, () =>
      runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        second.io,
        f.deps,
      ),
    ),
  ).toBe(3);
  const terminal = second.events.at(-1);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
  const record = JSON.parse(stored) as {
    sessionId: string;
    activeSessionId: string;
    binding: { cwd: string };
  };
  expect(record.binding.cwd).toBe(origin);
  expect(terminal?.error).toBe(pinnedMismatchError('working-directory mismatch'));
  expect(terminal?.error).not.toBe(CORRUPT_ROW_ERROR);
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.sessionId).toBe(record.sessionId);
  expect(terminal?.activeSessionId).toBe(record.activeSessionId);
  expect(terminal?.cwd).toBe(origin);
  expect(terminal?.pinned).toEqual({ cwd: origin });
  expect(String(terminal?.error)).not.toContain(origin);
  expect(String(terminal?.error)).not.toContain(elsewhere);
  expect(JSON.stringify(terminal)).toContain(origin);
  expect(JSON.stringify(terminal)).not.toContain(elsewhere);
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
  const restored = capture();
  expect(
    await inDirectory(origin, () =>
      runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        restored.io,
        f.deps,
      ),
    ),
  ).toBe(0);
  expect(restored.events.at(-1)).toMatchObject({
    type: 'turn.completed',
    outcome: 'completed',
    logicalTurnId,
  });
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
});

const PIN_DRIFTS: Array<{
  name: string;
  field: string;
  kind: string;
  stored: string | null;
  edit: (binding: LogicalTurnBinding) => LogicalTurnBinding;
}> = [
  {
    name: 'provider',
    field: 'provider',
    kind: 'provider mismatch',
    stored: 'anthropic',
    edit: (binding) => ({ ...binding, provider: 'anthropic' }),
  },
  {
    name: 'model',
    field: 'model',
    kind: 'model mismatch',
    stored: 'gpt-stored-pin',
    edit: (binding) => ({ ...binding, model: 'gpt-stored-pin' }),
  },
  {
    name: 'effort',
    field: 'effort',
    kind: 'effort mismatch',
    stored: 'max',
    edit: (binding) => ({ ...binding, effort: 'max' }),
  },
  {
    name: 'toolset',
    field: 'toolset',
    kind: 'toolset mismatch',
    stored: null,
    edit: ({ toolset: _omit, ...binding }) => binding,
  },
  {
    name: 'permission mode',
    field: 'permissionMode',
    kind: 'permission-mode mismatch',
    stored: null,
    edit: ({ permissionMode: _omit, ...binding }) => binding,
  },
  {
    name: 'bundle',
    field: 'bundleIdentity',
    kind: 'bundle mismatch',
    stored: '',
    edit: (binding) => ({ ...binding, bundleIdentity: '' }),
  },
  {
    name: 'auth',
    field: 'authKind',
    kind: 'auth mismatch',
    stored: 'oauth',
    edit: (binding) => ({ ...binding, authKind: 'oauth' }),
  },
];

for (const drift of PIN_DRIFTS) {
  test(`a ${drift.name} pin drift reports the stored value and not a corrupt row`, async () => {
    const f = fixture(answerProvider());
    mkdirSync(join(f.home, 'origin'));
    const origin = realpathSync(join(f.home, 'origin'));
    const first = capture();
    expect(await inDirectory(origin, () => runSdkRunCommand(opts, first.io, f.deps))).toBe(0);
    const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
    const sessionId = String(
      first.events.at(-1)?.sessionId ?? first.events.at(-1)?.activeSessionId,
    );
    rewriteLogicalTurnBinding(f.db, logicalTurnId, drift.edit);
    const stored = logicalTurnRecord(f.db, logicalTurnId);
    const second = capture();
    expect(
      await inDirectory(origin, () =>
        runSdkRunCommand(
          { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
          second.io,
          f.deps,
        ),
      ),
    ).toBe(3);
    const terminal = second.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      code: 'recovery_state_invalid',
      recoverable: false,
      nextAction: 'continue_logical_turn',
      logicalTurnId,
      sessionId,
      activeSessionId: sessionId,
      cwd: origin,
    });
    expect(terminal?.pinned).toEqual({ [drift.field]: drift.stored });
    expect(terminal?.error).toBe(pinnedMismatchError(drift.kind));
    expect(terminal?.error).not.toBe(CORRUPT_ROW_ERROR);
    expect(terminal?.nextAction).not.toBe('repair_request');
    expect(String(terminal?.error)).not.toContain(origin);
    expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
  });
}

test('a changed permission policy names the policy mismatch and keeps the row', async () => {
  const f = fixture(answerProvider());
  mkdirSync(join(f.home, 'origin'));
  const origin = realpathSync(join(f.home, 'origin'));
  const first = capture();
  expect(await inDirectory(origin, () => runSdkRunCommand(opts, first.io, f.deps))).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const stored = logicalTurnRecord(f.db, logicalTurnId);
  mkdirSync(join(origin, '.harness'));
  writeFileSync(
    join(origin, '.harness', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: [], deny: ['Bash'], ask: [] } }),
  );
  const second = capture();
  expect(
    await inDirectory(origin, () =>
      runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        second.io,
        f.deps,
      ),
    ),
  ).toBe(3);
  const terminal = second.events.at(-1);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
  const record = JSON.parse(stored) as {
    sessionId: string;
    activeSessionId: string;
    binding: { cwd: string; policyDigest?: string };
  };
  expect(terminal?.error).toBe(pinnedMismatchError('permission-policy mismatch'));
  expect(terminal?.error).not.toBe(CORRUPT_ROW_ERROR);
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.sessionId).toBe(record.sessionId);
  expect(terminal?.activeSessionId).toBe(record.activeSessionId);
  expect(terminal?.cwd).toBe(origin);
  expect(terminal?.pinned).toEqual({ policyDigest: record.binding.policyDigest });
  expect(String(terminal?.error)).not.toContain(origin);
  expect(JSON.stringify(terminal)).toContain(origin);
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
});

test('continuing a bypass turn with a wider skill approval refuses before those tools exist', async () => {
  let calls = 0;
  let boots = 0;
  let widenedTools = false;
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
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({ learning: { disabled: true }, review: { disabled: true } }),
  );
  f.deps.runtime = async (options) => {
    const runtime = await buildRuntime({
      ...options,
      harnessHome: f.home,
      dbPath: f.db,
      cronEnabled: false,
    });
    boots++;
    if (runtime.skillRegistryManager.snapshot().registry.byName.has('recoveryWidenSkill'))
      widenedTools = true;
    return runtime;
  };
  const project = join(f.home, 'project');
  const skillDir = join(f.home, 'skill-root', 'recoveryWidenSkill');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.agents', 'skills'), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  symlinkSync(skillDir, join(project, '.agents', 'skills', 'recoveryWidenSkill'));
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: recoveryWidenSkill',
      'description: Use when the user asks to check a widened approval',
      'whenToUse: Use when the user asks to check a widened approval',
      '---',
      'Widened skill body.',
      '',
    ].join('\n'),
  );
  const narrow = join(f.home, 'approval-narrow.json');
  const wide = join(f.home, 'approval-wide.json');
  const approval = (roots: string[]) =>
    JSON.stringify({ skills: { discovery: { allowedLinkRoots: roots } } });
  writeFileSync(narrow, approval([]));
  writeFileSync(wide, approval([skillDir]));
  const first = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          { ...opts, permissionMode: 'bypass', skillApprovalFile: narrow },
          first.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(0);
  expect(calls).toBe(1);
  expect(boots).toBe(1);
  expect(widenedTools).toBe(false);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const stored = logicalTurnRecord(f.db, logicalTurnId);
  const second = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          {
            json: true,
            sdk: true,
            db: f.db,
            continueLogicalTurn: logicalTurnId,
            permissionMode: 'bypass',
            skillApprovalFile: wide,
          },
          second.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(3);
  const terminal = second.events.at(-1);
  expect(second.events.some((event) => event.type === 'session.started')).toBe(false);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
  const record = JSON.parse(stored) as {
    sessionId: string;
    activeSessionId: string;
    binding: { cwd: string; skillApprovalDigest?: string };
  };
  expect(terminal?.error).toBe(pinnedMismatchError('skill-approval mismatch'));
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.sessionId).toBe(record.sessionId);
  expect(terminal?.activeSessionId).toBe(record.activeSessionId);
  expect(terminal?.cwd).toBe(realpathSync(project));
  expect(terminal?.pinned).toEqual({ skillApprovalDigest: record.binding.skillApprovalDigest });
  expect(String(terminal?.error)).not.toContain('working-directory');
  expect(String(terminal?.error)).not.toContain('permission-policy');
  expect(String(terminal?.error)).not.toContain(skillDir);
  expect(String(terminal?.error)).not.toContain('recovery state is invalid');
  expect(calls).toBe(1);
  expect(boots).toBe(1);
  expect(widenedTools).toBe(false);
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
});

test('a changed MCP server identity is recovery_state_invalid before that server exists', async () => {
  let calls = 0;
  let boots = 0;
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
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({ learning: { disabled: true }, review: { disabled: true } }),
  );
  f.deps.runtime = async (options) => {
    const runtime = await buildRuntime({
      ...options,
      harnessHome: f.home,
      dbPath: f.db,
      cronEnabled: false,
    });
    boots++;
    return runtime;
  };
  const project = join(f.home, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  const first = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand({ ...opts, permissionMode: 'bypass' }, first.io, f.deps),
      ),
    ),
  ).toBe(0);
  expect(calls).toBe(1);
  expect(boots).toBe(1);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const stored = logicalTurnRecord(f.db, logicalTurnId);
  mkdirSync(join(project, '.harness'), { recursive: true });
  writeFileSync(
    join(project, '.harness', 'settings.local.json'),
    JSON.stringify({
      mcpServers: { widened: { type: 'http', url: 'http://127.0.0.1:9/mcp' } },
    }),
  );
  const second = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          {
            json: true,
            sdk: true,
            db: f.db,
            continueLogicalTurn: logicalTurnId,
            permissionMode: 'bypass',
          },
          second.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(3);
  const terminal = second.events.at(-1);
  expect(second.events.some((event) => event.type === 'session.started')).toBe(false);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
  const record = JSON.parse(stored) as {
    sessionId: string;
    activeSessionId: string;
    binding: { cwd: string; mcpIdentityDigest?: string };
  };
  expect(terminal?.error).toBe(pinnedMismatchError('MCP mismatch'));
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.sessionId).toBe(record.sessionId);
  expect(terminal?.activeSessionId).toBe(record.activeSessionId);
  expect(terminal?.cwd).toBe(realpathSync(project));
  expect(terminal?.pinned).toEqual({ mcpIdentityDigest: record.binding.mcpIdentityDigest });
  expect(String(terminal?.error)).not.toContain('working-directory');
  expect(String(terminal?.error)).not.toContain('permission-policy');
  expect(String(terminal?.error)).not.toContain('127.0.0.1');
  expect(String(terminal?.error)).not.toContain('recovery state is invalid');
  expect(calls).toBe(1);
  expect(boots).toBe(1);
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
});

for (const state of ['unknown', 'started'] as const) {
  test(`continuing a ${state} tool receipt is recovery_unsafe without a provider call`, async () => {
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
    expect(calls).toBe(1);
    const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
    const sessionId = String(first.events.at(-1)?.activeSessionId);
    const db = SessionDb.open({ path: f.db });
    try {
      const record = db.loadLogicalTurn(logicalTurnId);
      if (!record) throw new Error('logical turn row missing');
      record.status = 'running';
      db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
        JSON.stringify(record),
        logicalTurnId,
      ]);
      const assistantMessageId = db.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `effect-${state}`, name: 'fixture', input: {} }],
      });
      db.saveToolExecution(sessionId, {
        assistantMessageId,
        toolUseId: `effect-${state}`,
        state,
      });
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
      outcome: 'failed',
      reason: 'unsafe_effect',
      code: 'recovery_unsafe',
      error: 'Logical turn cannot continue because a tool effect is not safely replayable.',
      recoverable: false,
      nextAction: 'inspect_session',
      sessionId: null,
      logicalTurnId,
    });
    expect(JSON.stringify(second.events)).not.toContain('storage_failed');
    expect(JSON.stringify(second.events)).not.toContain('inspect_storage');
    expect(JSON.stringify(second.events)).not.toContain('Session storage failed');
    const failed = storedLogicalTurn(f.db, logicalTurnId);
    expect(failed.record.status).toBe('failed');
    expect(failed.record.finishReason).toBe('unsafe_effect');
    expect(failed.record).not.toHaveProperty('segmentLimit');
    expect(failed.leaseOwner).toBeNull();
    const third = capture();
    expect(
      await runSdkRunCommand(
        { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
        third.io,
        f.deps,
      ),
    ).toBe(3);
    expect(calls).toBe(1);
    expect(third.events.at(-1)).toMatchObject({
      type: 'turn.error',
      outcome: 'failed',
      reason: 'unsafe_effect',
      code: 'continuation_failed',
      recoverable: false,
      nextAction: 'none',
      logicalTurnId,
    });
    expect(storedLogicalTurn(f.db, logicalTurnId).record.status).toBe('failed');
  });
}

test('continuing an ambiguous truncated tool call records failed', async () => {
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
  const sessionId = String(first.events.at(-1)?.activeSessionId);
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'continuing';
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
    db.saveMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'truncated-tool', name: 'fixture', input: {} }],
    });
    db.saveMessage(sessionId, {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'truncated-tool',
          content: AMBIGUOUS_MAX_TOKENS_TOOL_NOTE,
          is_error: true,
        },
      ],
    });
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
    outcome: 'failed',
    reason: 'unsafe_effect',
    code: 'recovery_unsafe',
    recoverable: false,
    nextAction: 'inspect_session',
    logicalTurnId,
  });
  const failed = storedLogicalTurn(f.db, logicalTurnId);
  expect(failed.record.status).toBe('failed');
  expect(failed.record.finishReason).toBe('unsafe_effect');
  expect(failed.record).not.toHaveProperty('segmentLimit');
  expect(failed.leaseOwner).toBeNull();
  const third = capture();
  expect(
    await runSdkRunCommand(
      { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
      third.io,
      f.deps,
    ),
  ).toBe(3);
  expect(calls).toBe(1);
  expect(third.events.at(-1)?.code).toBe('continuation_failed');
  expect(storedLogicalTurn(f.db, logicalTurnId).record.status).toBe('failed');
});

test('a continuation with an unreadable session store still reports storage_failed', async () => {
  let calls = 0;
  let fault = false;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('durable answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    const get = runtime.sessionDb.getSession.bind(runtime.sessionDb);
    let reads = 0;
    runtime.sessionDb.getSession = (sessionId: string, owner?: string) => {
      reads += 1;
      if (fault && reads > 1) throw new Error('private continuation store failure');
      return get(sessionId, owner);
    };
  });
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, f.deps)).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'running';
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
  } finally {
    db.close();
  }
  fault = true;
  const second = capture();
  expect(
    await runSdkRunCommand(
      { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
      second.io,
      f.deps,
    ),
  ).toBe(1);
  expect(calls).toBe(1);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'storage_failed',
    recoverable: false,
    nextAction: 'inspect_storage',
  });
  expect(second.events.at(-1)?.code).not.toBe('recovery_unsafe');
  expect(JSON.stringify(second.events)).not.toContain('private continuation store failure');
});

test('segment 2 rehydrates a UserPromptSubmit rewrite instead of the original prompt', async () => {
  const seen: string[] = [];
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      calls++;
      const prompt = request.messages
        .filter((message) => message.role === 'user' && message.origin !== 'runtime')
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      seen.push(prompt);
      if (calls <= 6) {
        const reply: AssistantMessage = {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `rewrite-${calls}`, name: 'WebSearch', input: { n: calls } },
          ],
        };
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      const reply = message('done');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.loop = { mode: 'off' };
    runtime.hookRunner = async (event) => {
      if (event === 'UserPromptSubmit')
        return { block: false, rewrittenPrompt: 'rewritten-by-hook' };
      return { block: false };
    };
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'WebSearch',
        description: () => 'fixture',
        inputSchema: z.unknown(),
        async call() {
          return { data: 'receipt' };
        },
      }),
    );
  });
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'web' }, c.io, f.deps)).toBe(0);
  // Web segments stop at 6 model calls. Call 7 is the first call of segment 2.
  expect(calls).toBe(7);
  expect(seen).toHaveLength(7);
  for (const prompt of seen) {
    expect(prompt).toContain('rewritten-by-hook');
    expect(prompt).not.toContain('question');
  }
});

test('a rewritten prompt is stored without memory or recall fences', async () => {
  const seen: string[] = [];
  let calls = 0;
  let memorySnapshots = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      calls++;
      const prompt = request.messages
        .filter((message) => message.role === 'user' && message.origin !== 'runtime')
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      seen.push(prompt);
      if (calls <= 6) {
        const reply: AssistantMessage = {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `fence-${calls}`, name: 'WebSearch', input: { n: calls } },
          ],
        };
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: reply };
        return reply;
      }
      const reply = message('done');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.loop = { mode: 'off' };
    runtime.hookRunner = async (event) => {
      if (event === 'UserPromptSubmit')
        return { block: false, rewrittenPrompt: 'rewritten-by-hook' };
      return { block: false };
    };
    const readContext = runtime.getSessionContext.bind(runtime);
    runtime.getSessionContext = (sessionId: string) => {
      const ctx = readContext(sessionId);
      ctx.memoryManager.prefetchSnapshot = async () => {
        const body = memorySnapshots === 0 ? 'MemorySnapOne' : 'MemorySnapTwo';
        memorySnapshots += 1;
        return formatMemorySnapshot({ memory: body });
      };
      ctx.recall = async () => ({ injectionText: 'RecallLessonMarker', lessons: [] });
      return ctx;
    };
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'WebSearch',
        description: () => 'fixture',
        inputSchema: z.unknown(),
        async call() {
          return { data: 'receipt' };
        },
      }),
    );
  });
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, toolset: 'web' }, c.io, f.deps)).toBe(0);
  expect(calls).toBe(7);
  expect(memorySnapshots).toBe(2);
  const segment = seen.slice(0, 6);
  expect(segment).toHaveLength(6);
  for (const prompt of segment) {
    expect(prompt).toContain('rewritten-by-hook');
    expect(prompt).toContain('MemorySnapOne');
    expect(prompt).toContain('RecallLessonMarker');
    expect(prompt).toContain('<recall-context>');
    expect(prompt).toContain(FENCE_PREAMBLE);
    expect(prompt).not.toContain('question');
    expect(prompt).not.toContain('MemorySnapTwo');
  }
  const next = seen[6] ?? '';
  expect(next).toContain('rewritten-by-hook');
  expect(next).toContain('MemorySnapTwo');
  expect(next).toContain(FENCE_PREAMBLE);
  expect(next).not.toContain('MemorySnapOne');
  expect(next).toContain('RecallLessonMarker');
  expect(next.split('</recall-context>').length - 1).toBe(1);
  expect(next).not.toContain('question');
  const db = SessionDb.open({ path: f.db });
  try {
    const session = db.handle
      .query<{ session_id: string }, []>('SELECT session_id FROM sessions')
      .get();
    const stored = db.loadMessages(session?.session_id ?? '');
    const human = [...stored].reverse().find((row) => {
      if (row.role !== 'user') return false;
      if (row.content.some((block) => block.type === 'tool_result')) return false;
      const marker = row.toolCalls;
      if (
        marker &&
        typeof marker === 'object' &&
        (marker as { origin?: unknown }).origin === 'runtime'
      )
        return false;
      return true;
    });
    expect(human?.content).toEqual([{ type: 'text', text: 'rewritten-by-hook' }]);
    expect(db.search('MemorySnapOne')).toEqual([]);
    expect(db.search('MemorySnapTwo')).toEqual([]);
    expect(db.search('RecallLessonMarker')).toEqual([]);
  } finally {
    db.close();
  }
});

test('a blocked prompt is not sent when the failed logical turn is continued', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.hookRunner = async (event) => {
      if (event === 'UserPromptSubmit') return { block: true, reason: 'forbidden prompt' };
      return { block: false };
    };
  });
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, f.deps)).not.toBe(0);
  expect(calls).toBe(0);
  const denied = first.events.find((event) => event.type === 'turn.error');
  expect(denied).toMatchObject({
    type: 'turn.error',
    code: 'policy_denied',
    recoverable: false,
    nextAction: 'none',
  });
  expect(denied?.code).not.toBe('provider_failed');
  expect(denied?.nextAction).not.toBe('repair_request');
  expect(String(denied?.error)).toContain('forbidden prompt');
  expect(String(denied?.error).toLowerCase()).not.toContain('provider failed');
  const db = SessionDb.open({ path: f.db });
  let logicalTurnId = '';
  try {
    const rows = db.handle.query<{ record: string }, []>('SELECT record FROM logical_turns').all();
    expect(rows).toHaveLength(1);
    const record = JSON.parse(rows[0]?.record ?? '{}') as {
      logicalTurnId: string;
      status: string;
      finishReason?: string;
    };
    logicalTurnId = record.logicalTurnId;
    expect(record.status).toBe('failed');
    expect(record.finishReason).not.toBe('transient_provider');
    const session = db.handle
      .query<{ session_id: string }, []>('SELECT session_id FROM sessions')
      .get();
    const stored = db.loadMessages(session?.session_id ?? '');
    expect(stored.find((row) => row.role === 'user')?.content).toEqual([
      { type: 'text', text: 'forbidden prompt' },
    ]);
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
  expect(calls).toBe(0);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'failed',
    code: 'continuation_failed',
    recoverable: false,
    nextAction: 'none',
    logicalTurnId,
  });
  expect(second.events.at(-1)?.nextAction).not.toBe('continue_logical_turn');
  expect(second.events.at(-1)?.nextAction).not.toBe('resume');
});

test('a stolen lease blocks the gated prompt write and the provider stream', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.hookRunner = async (event) => {
      if (event !== 'UserPromptSubmit') return { block: false };
      const row = runtime.sessionDb.handle
        .query<{ logical_turn_id: string }, []>('SELECT logical_turn_id FROM logical_turns')
        .get();
      if (!row) throw new Error('logical turn missing');
      runtime.sessionDb.handle.run(
        'UPDATE logical_turns SET lease_expires_at = ? WHERE logical_turn_id = ?',
        [Date.now() - 1, row.logical_turn_id],
      );
      const acquired = runtime.sessionDb.acquireLogicalTurnLease(
        row.logical_turn_id,
        'second-owner',
        Date.now() + 60_000,
        Date.now(),
      );
      if (!acquired) throw new Error('second owner did not acquire');
      return { block: false, rewrittenPrompt: 'rewritten-by-hook' };
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(3);
  expect(calls).toBe(0);
  expect(c.events.find((event) => event.type === 'turn.error')).toMatchObject({
    type: 'turn.error',
    code: 'logical_turn_leased',
  });
  const db = SessionDb.open({ path: f.db });
  try {
    const session = db.handle
      .query<{ session_id: string }, []>('SELECT session_id FROM sessions')
      .get();
    const stored = db.loadMessages(session?.session_id ?? '');
    expect(stored.find((row) => row.role === 'user')?.content).toEqual([
      { type: 'text', text: 'question' },
    ]);
    expect(
      db.handle
        .query<{ lease_owner: string | null }, []>('SELECT lease_owner FROM logical_turns')
        .get()?.lease_owner,
    ).toBe('second-owner');
  } finally {
    db.close();
  }
});

test('a policy denial does not overwrite the prompt after another owner acquires the lease', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    const release = runtime.sessionDb.releaseLogicalTurnLease.bind(runtime.sessionDb);
    runtime.sessionDb.releaseLogicalTurnLease = (id, owner) => {
      release(id, owner);
      const acquired = runtime.sessionDb.acquireLogicalTurnLease(
        id,
        'second-owner',
        Date.now() + 60_000,
        Date.now(),
      );
      if (!acquired) throw new Error('second owner did not acquire');
      const session = runtime.sessionDb.handle
        .query<{ session_id: string }, []>('SELECT session_id FROM sessions')
        .get();
      const human = runtime.sessionDb
        .loadMessages(session?.session_id ?? '')
        .find(
          (row) =>
            row.role === 'user' && !row.content.some((block) => block.type === 'tool_result'),
        );
      if (!human) throw new Error('user row missing');
      runtime.sessionDb.handle.run('UPDATE messages SET content = ? WHERE id = ?', [
        JSON.stringify([{ type: 'text', text: 'second-owner prompt' }]),
        human.id,
      ]);
    };
    runtime.hookRunner = async (event) => {
      if (event === 'UserPromptSubmit') return { block: true, reason: 'forbidden prompt' };
      return { block: false };
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(1);
  expect(calls).toBe(0);
  const denied = c.events.find((event) => event.type === 'turn.error');
  expect(denied).toMatchObject({
    type: 'turn.error',
    code: 'policy_denied',
    recoverable: false,
    nextAction: 'none',
  });
  const db = SessionDb.open({ path: f.db });
  try {
    const session = db.handle
      .query<{ session_id: string }, []>('SELECT session_id FROM sessions')
      .get();
    const stored = db.loadMessages(session?.session_id ?? '');
    expect(stored.find((row) => row.role === 'user')?.content).toEqual([
      { type: 'text', text: 'second-owner prompt' },
    ]);
    expect(
      db.handle
        .query<{ lease_owner: string | null }, []>('SELECT lease_owner FROM logical_turns')
        .get()?.lease_owner,
    ).toBe('second-owner');
  } finally {
    db.close();
  }
});

test('a failed logical turn resumes only when the stored cause is a safe transient', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message(calls === 1 ? 'durable answer' : 'retried answer');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider);
  const first = capture();
  expect(await runSdkRunCommand(opts, first.io, f.deps)).toBe(0);
  expect(calls).toBe(1);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    record.status = 'failed';
    record.finishReason = 'transient_provider';
    record.lastCause = 'error';
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
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
  ).toBe(0);
  expect(calls).toBe(2);
  expect(second.events.at(-1)).toMatchObject({
    type: 'turn.completed',
    logicalTurnId,
    reply: 'retried answer',
  });
});

test('a PreToolUse matcher change is recovery_state_invalid before hook spawn', async () => {
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
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({ learning: { disabled: true }, review: { disabled: true } }),
  );
  const project = join(f.home, 'project');
  const marker = join(f.home, 'hook-ran');
  const script = join(f.home, 'hook.sh');
  mkdirSync(join(project, '.harness'), { recursive: true });
  writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(script, 0o755);
  const command = script;
  const hooks = (matcher: string) =>
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] },
    });
  writeFileSync(join(project, '.harness', 'settings.local.json'), hooks('Read'));
  writeFileSync(
    join(f.home, 'shell-hooks-allowlist.json'),
    JSON.stringify({ version: 1, decisions: { [`PreToolUse:${command}`]: 'allow' } }),
  );
  const first = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand({ ...opts, permissionMode: 'bypass' }, first.io, f.deps),
      ),
    ),
  ).toBe(0);
  expect(calls).toBe(1);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const stored = logicalTurnRecord(f.db, logicalTurnId);
  expect(stored).not.toContain(script);
  expect(stored).not.toContain('hook.sh');
  const same = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          {
            json: true,
            sdk: true,
            db: f.db,
            continueLogicalTurn: logicalTurnId,
            permissionMode: 'bypass',
          },
          same.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(0);
  expect(calls).toBe(1);
  writeFileSync(join(project, '.harness', 'settings.local.json'), hooks('*'));
  const second = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          {
            json: true,
            sdk: true,
            db: f.db,
            continueLogicalTurn: logicalTurnId,
            permissionMode: 'bypass',
          },
          second.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(3);
  const terminal = second.events.at(-1);
  expect(second.events.some((event) => event.type === 'session.started')).toBe(false);
  expect(terminal).toMatchObject({
    type: 'turn.error',
    code: 'recovery_state_invalid',
    recoverable: false,
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
  const record = JSON.parse(stored) as {
    sessionId: string;
    activeSessionId: string;
    binding: { cwd: string; hookScopeDigest?: string };
  };
  expect(terminal?.error).toBe(pinnedMismatchError('hook-scope mismatch'));
  expect(terminal?.nextAction).not.toBe('repair_request');
  expect(terminal?.sessionId).toBe(record.sessionId);
  expect(terminal?.activeSessionId).toBe(record.activeSessionId);
  expect(terminal?.cwd).toBe(realpathSync(project));
  expect(terminal?.pinned).toEqual({ hookScopeDigest: record.binding.hookScopeDigest });
  expect(String(terminal?.error)).not.toContain(script);
  expect(String(terminal?.error)).not.toContain(marker);
  expect(calls).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(logicalTurnRecord(f.db, logicalTurnId)).toBe(stored);
});

function bindingDigest(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item)]),
      );
    }
    return entry;
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

test('a pre-pin row continues only when the current hooks cannot widen', async () => {
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
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({ learning: { disabled: true }, review: { disabled: true } }),
  );
  const project = join(f.home, 'project');
  mkdirSync(project, { recursive: true });
  const first = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () => runSdkRunCommand(opts, first.io, f.deps)),
    ),
  ).toBe(0);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    expect(typeof record.binding.hookScopeDigest).toBe('string');
    const { hookScopeDigest: _omit, ...binding } = record.binding;
    record.binding = binding;
    record.bindingDigest = bindingDigest(record.binding);
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
  } finally {
    db.close();
  }
  const open = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
          open.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(0);
  expect(calls).toBe(1);
  const widened = SessionDb.open({ path: f.db });
  try {
    const record = widened.loadLogicalTurn(logicalTurnId);
    if (!record) throw new Error('logical turn row missing');
    const { hookScopeDigest: _omit, ...binding } = record.binding;
    record.binding = binding;
    record.bindingDigest = bindingDigest(record.binding);
    widened.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify(record),
      logicalTurnId,
    ]);
  } finally {
    widened.close();
  }
  mkdirSync(join(project, '.harness'), { recursive: true });
  const command = join(f.home, 'hook.sh');
  writeFileSync(command, '#!/bin/sh\nexit 0\n');
  chmodSync(command, 0o755);
  writeFileSync(
    join(project, '.harness', 'settings.local.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    }),
  );
  const blocked = capture();
  expect(
    await withHarness(f.home, () =>
      inDirectory(project, () =>
        runSdkRunCommand(
          { json: true, sdk: true, db: f.db, continueLogicalTurn: logicalTurnId },
          blocked.io,
          f.deps,
        ),
      ),
    ),
  ).toBe(3);
  expect(blocked.events.some((event) => event.type === 'session.started')).toBe(false);
  expect(blocked.events.at(-1)?.nextAction).toBe('continue_logical_turn');
  expect(blocked.events.at(-1)?.nextAction).not.toBe('repair_request');
  expect(blocked.events.at(-1)?.error).toBe(pinnedMismatchError('hook-scope mismatch'));
  expect(blocked.events.at(-1)?.cwd).toBe(realpathSync(project));
  expect(blocked.events.at(-1)?.pinned).toEqual({ hookScopeDigest: null });
  expect(String(blocked.events.at(-1)?.error)).not.toContain(command);
  expect(calls).toBe(1);
});

const MAX_TIMER_MS = 2_147_483_647;

/** Delays above the 32-bit timer max fire on the next turn. A max-sized chunk stays pending. */
async function withCollapsedLongTimers(run: (delays: number[]) => Promise<void>): Promise<void> {
  const delays: number[] = [];
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const held = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((handler: unknown, timeout?: number, ...args: unknown[]) => {
    const delay = typeof timeout === 'number' ? timeout : 0;
    delays.push(delay);
    if (delay > MAX_TIMER_MS) {
      queueMicrotask(() => {
        if (typeof handler === 'function') (handler as (...params: unknown[]) => void)(...args);
      });
      const idle = originalSet(() => {}, 60_000);
      held.add(idle);
      return idle;
    }
    if (delay === MAX_TIMER_MS) {
      const idle = originalSet(() => {}, 60_000);
      held.add(idle);
      return idle;
    }
    return originalSet(handler as Parameters<typeof setTimeout>[0], delay, ...(args as []));
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) held.delete(id);
    originalClear(id);
  }) as typeof clearTimeout;
  try {
    await run(delays);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    for (const id of held) originalClear(id);
  }
}

test('a long deadline does not abort on the first timer tick', async () => {
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
  await withCollapsedLongTimers(async (delays) => {
    const first = capture();
    expect(
      await runSdkRunCommand({ ...opts, deadlineMs: MAX_TIMER_MS + 1 }, first.io, f.deps),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(delays.some((delay) => delay > MAX_TIMER_MS)).toBe(false);
    expect(delays).toContain(MAX_TIMER_MS);
    const terminal = first.events.at(-1);
    expect(terminal).toMatchObject({ type: 'turn.completed', outcome: 'completed' });
    expect(terminal?.reason).not.toBe('deadline');
    const logicalTurnId = String(terminal?.logicalTurnId);
    const db = SessionDb.open({ path: f.db });
    try {
      const record = db.loadLogicalTurn(logicalTurnId);
      expect(record?.status).toBe('completed');
      expect(record?.status).not.toBe('exhausted');
      expect(record?.finishReason).not.toBe('deadline');
    } finally {
      db.close();
    }
    const continued = capture();
    expect(
      await runSdkRunCommand(
        {
          json: true,
          sdk: true,
          db: f.db,
          continueLogicalTurn: logicalTurnId,
        },
        continued.io,
        f.deps,
      ),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(continued.events.at(-1)?.reason).not.toBe('deadline');
    expect(delays.some((delay) => delay > MAX_TIMER_MS)).toBe(false);
  });
});

test('a longer continue deadline is rejected and does not move the stored instant', async () => {
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
  expect(await runSdkRunCommand({ ...opts, deadlineMs: 60_000 }, first.io, f.deps)).toBe(0);
  expect(calls).toBe(1);
  const logicalTurnId = String(first.events.at(-1)?.logicalTurnId);
  const soon = Date.now() + 1_000;
  const db = SessionDb.open({ path: f.db });
  try {
    const record = db.loadLogicalTurn(logicalTurnId);
    expect(record?.status).toBe('completed');
    expect(record?.deadlineAt).toBeGreaterThan(Date.now());
    db.handle.run('UPDATE logical_turns SET record = ? WHERE logical_turn_id = ?', [
      JSON.stringify({ ...record, status: 'running', deadlineAt: soon }),
      logicalTurnId,
    ]);
  } finally {
    db.close();
  }
  const continued = capture();
  expect(
    await runSdkRunCommand(
      {
        json: true,
        sdk: true,
        db: f.db,
        continueLogicalTurn: logicalTurnId,
        deadlineMs: 600_000,
      },
      continued.io,
      f.deps,
    ),
  ).toBe(2);
  expect(calls).toBe(1);
  expect(String(continued.events.at(-1)?.error)).toContain('was not applied');
  expect(String(continued.events.at(-1)?.error)).toContain('stored logical-turn deadline');
  const after = SessionDb.open({ path: f.db });
  try {
    const record = after.loadLogicalTurn(logicalTurnId);
    expect(record?.status).toBe('running');
    expect(record?.deadlineAt).toBe(soon);
  } finally {
    after.close();
  }
});

test('a short deadline still aborts while long timers are chunked', async () => {
  await withCollapsedLongTimers(async () => {
    const c = capture();
    expect(
      await runSdkRunCommand(
        { ...opts, deadlineMs: 20 },
        { ...c.io, readStdin: async () => new Promise<string>(() => {}) },
      ),
    ).toBe(3);
    expect(c.events[0]).toMatchObject({
      type: 'turn.error',
      outcome: 'exhausted',
      reason: 'deadline',
      code: 'continuation_exhausted',
    });
  });
});

function logicalTurnIdRow(path: string): string {
  const db = SessionDb.open({ path });
  try {
    const row = db.handle
      .query<{ logical_turn_id: string }, []>('SELECT logical_turn_id FROM logical_turns')
      .get();
    if (!row?.logical_turn_id) throw new Error('logical turn row missing');
    return row.logical_turn_id;
  } finally {
    db.close();
  }
}

test('prepare storage failure names the logical turn created before compaction', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.proactiveCompactThreshold = 0;
    runtime.compact = async () => {
      throw new SessionPersistenceError(new Error('compact failed after admit'));
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(1);
  expect(calls).toBe(0);
  const logicalTurnId = logicalTurnIdRow(f.db);
  const started = c.events.find((event) => event.type === 'session.started');
  expect(started?.logicalTurnId).toBe(logicalTurnId);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'storage_failed',
    logicalTurnId,
  });
  const db = SessionDb.open({ path: f.db });
  try {
    expect(db.loadLogicalTurn(logicalTurnId)?.status).toBe('running');
  } finally {
    db.close();
  }
});

test('a lease refusal on a new logical turn names the admitted id', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      const reply = message('should not run');
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.sessionDb.acquireLogicalTurnLease = () => false;
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(3);
  expect(calls).toBe(0);
  const logicalTurnId = logicalTurnIdRow(f.db);
  const started = c.events.find((event) => event.type === 'session.started');
  expect(started?.logicalTurnId).toBe(logicalTurnId);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'logical_turn_leased',
    nextAction: 'continue_logical_turn',
    logicalTurnId,
  });
});
