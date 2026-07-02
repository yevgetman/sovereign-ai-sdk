// Regression tests for the G9-router fix group.
//
// #17 (MED): lane-model recovery must NOT depend on req.model still being the
//   synthetic "<local> | <frontier>" display string. When /model is run in
//   router mode, runtime.model becomes a single literal model id (no " | "),
//   and the old M25 code handed that single literal to BOTH lanes. The router
//   must resolve each lane's model from the resolved lane models supplied at
//   construction, independent of the mutable req.model.
// #33 (LOW): the audit record + route_decision event must report the model the
//   child actually receives — never an empty string.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { RouterAuditLogger } from '../../src/router/auditLogger.js';
import { RouterProvider } from '../../src/router/provider.js';
import type { RouterConfig } from '../../src/router/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-router-decouple-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
};

/** A child provider that records the model id of the request it receives. */
function capturingProvider(name: string, sink: { model?: string }): LLMProvider {
  return {
    name,
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      sink.model = req.model;
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: COMPLETED };
      return COMPLETED;
    },
  };
}

const baseReq: ProviderRequest = {
  model: 'unused',
  system: [{ text: 'you are helpful', cacheable: true }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }],
  maxTokens: 256,
};

async function consume(
  provider: LLMProvider,
  req: ProviderRequest,
): Promise<{ events: StreamEvent[]; final: AssistantMessage }> {
  const events: StreamEvent[] = [];
  const gen = provider.stream(req);
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, final: step.value };
    events.push(step.value);
  }
}

describe('RouterProvider — lane model decoupled from req.model (#17)', () => {
  test('local lane gets its resolved model even when /model overwrote req.model with a single literal', async () => {
    // Simulates `/model claude-sonnet-4-6` in router mode: runtime.model is now
    // a single literal (no " | "), so the legacy synthetic-string parse would
    // hand the local lane the WRONG model. The resolved-lane opts must win.
    const localSink: { model?: string } = {};
    const config: RouterConfig = { localProvider: 'ollama', frontierProvider: 'anthropic' };
    const router = new RouterProvider({
      config,
      localProvider: capturingProvider('ollama', localSink),
      frontierProvider: capturingProvider('anthropic', {}),
      resolvedLocalModel: 'qwen2.5:14b',
      resolvedFrontierModel: 'claude-sonnet-4-6',
    });
    // req.model is the single literal a /model command would have set.
    await consume(router, { ...baseReq, model: 'claude-sonnet-4-6' });
    expect(localSink.model).toBe('qwen2.5:14b');
  });

  test('frontier lane gets its resolved model even when req.model is a single literal', async () => {
    const frontierSink: { model?: string } = {};
    const config: RouterConfig = {
      localProvider: 'ollama',
      frontierProvider: 'anthropic',
      escalationMode: 'auto',
    };
    const router = new RouterProvider({
      config,
      localProvider: capturingProvider('ollama', {}),
      frontierProvider: capturingProvider('anthropic', frontierSink),
      resolvedLocalModel: 'qwen2.5:14b',
      resolvedFrontierModel: 'claude-sonnet-4-6',
      getNextOverride: () => 'frontier',
    });
    await consume(router, { ...baseReq, model: 'some-other-model' });
    expect(frontierSink.model).toBe('claude-sonnet-4-6');
  });

  test('configured per-lane model still wins over the resolved opt', async () => {
    const localSink: { model?: string } = {};
    const config: RouterConfig = {
      localProvider: 'ollama',
      frontierProvider: 'anthropic',
      localModel: 'configured-local',
    };
    const router = new RouterProvider({
      config,
      localProvider: capturingProvider('ollama', localSink),
      frontierProvider: capturingProvider('anthropic', {}),
      resolvedLocalModel: 'resolved-local',
      resolvedFrontierModel: 'resolved-frontier',
    });
    await consume(router, { ...baseReq, model: 'whatever' });
    expect(localSink.model).toBe('configured-local');
  });

  test('legacy synthetic-string fallback still works when no resolved opts are supplied', async () => {
    const localSink: { model?: string } = {};
    const router = new RouterProvider({
      config: { localProvider: 'ollama', frontierProvider: 'anthropic' },
      localProvider: capturingProvider('ollama', localSink),
      frontierProvider: capturingProvider('anthropic', {}),
    });
    await consume(router, { ...baseReq, model: 'qwen-real | claude-real' });
    expect(localSink.model).toBe('qwen-real');
  });
});

describe('RouterProvider — observability matches the wire (#33)', () => {
  test('audit record + route_decision report the model the child actually received', async () => {
    // Pathological legacy case: no per-lane config, no resolved opts, and
    // req.model is NOT in synthetic form. recoverLaneModel returns ''.
    // Observability must report what the child actually saw (req.model),
    // never an empty model string.
    const localSink: { model?: string } = {};
    const auditLogger = new RouterAuditLogger({ harnessHome: home });
    const router = new RouterProvider({
      config: { localProvider: 'ollama', frontierProvider: 'anthropic' },
      localProvider: capturingProvider('ollama', localSink),
      frontierProvider: capturingProvider('anthropic', {}),
      auditLogger,
      sessionId: 'obs-session',
    });
    const { events } = await consume(router, { ...baseReq, model: 'single-literal-model' });
    await auditLogger.close();

    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    // The child actually received req.model unchanged in this fallthrough case.
    expect(localSink.model).toBe('single-literal-model');
    // Observability must agree with the wire — not report an empty string.
    expect(route.info.delegatedModel).toBe('single-literal-model');
    expect(route.info.delegatedModel).not.toBe('');

    const entry = JSON.parse(readFileSync(auditLogger.path, 'utf8').trim()) as Record<
      string,
      unknown
    >;
    expect(entry.model).toBe('single-literal-model');
    expect(entry.model).not.toBe('');
  });
});
