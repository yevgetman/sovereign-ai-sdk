// Phase 10.6 — RouterProvider integration tests with fake child providers.
// Verifies: delegation per classifier decision, route_decision StreamEvent
// emission, audit logging, override-hook support.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { RouterAuditLogger } from '../../src/router/auditLogger.js';
import { RouterProvider } from '../../src/router/provider.js';
import type { RouterConfig } from '../../src/router/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-router-prov-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const COMPLETED: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
};

function fakeProvider(name: string): LLMProvider {
  return {
    name,
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: name };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: COMPLETED };
      return COMPLETED;
    },
  };
}

const baseConfig: RouterConfig = {
  localProvider: 'ollama',
  localModel: 'qwen2.5:14b',
  frontierProvider: 'anthropic',
  frontierModel: 'claude-sonnet-4-6',
};

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

describe('RouterProvider', () => {
  test('delegates to the local provider on a default-classified turn', async () => {
    const local = fakeProvider('ollama');
    const frontier = fakeProvider('anthropic');
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: local,
      frontierProvider: frontier,
    });
    const { events } = await consume(router, baseReq);
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('local');
    expect(route.info.delegatedProvider).toBe('ollama');
    expect(route.info.delegatedModel).toBe('qwen2.5:14b');
    // Local provider's text_delta should appear in the stream.
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ollama')).toBe(true);
  });

  test("delegates to the frontier provider when classifier says so (escalationMode 'auto')", async () => {
    const local = fakeProvider('ollama');
    const frontier = fakeProvider('anthropic');
    const router = new RouterProvider({
      config: { ...baseConfig, escalationMode: 'auto' },
      localProvider: local,
      frontierProvider: frontier,
      // Force a frontier trigger via getNextOverride.
      getNextOverride: () => 'frontier',
    });
    const { events } = await consume(router, baseReq);
    const route = events.find((e) => e.type === 'route_decision');
    if (route?.type !== 'route_decision') throw new Error('no route_decision');
    expect(route.info.lane).toBe('frontier');
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'anthropic')).toBe(true);
  });

  test('writes one audit-log entry per stream() call', async () => {
    const auditLogger = new RouterAuditLogger({ harnessHome: home });
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('ollama'),
      frontierProvider: fakeProvider('anthropic'),
      auditLogger,
      sessionId: 'audit-session',
    });
    await consume(router, baseReq);
    await consume(router, baseReq);
    await auditLogger.close();
    const lines = readFileSync(auditLogger.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(first.sessionId).toBe('audit-session');
    expect(first.lane).toBe('local');
    expect(first.provider).toBe('ollama');
    expect(first.model).toBe('qwen2.5:14b');
    expect(first.contextByteCount).toBeGreaterThan(0);
    expect((first.promptHash as string).length).toBe(64);
  });

  test('records the userOverride field when an override is applied', async () => {
    const auditLogger = new RouterAuditLogger({ harnessHome: home });
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('ollama'),
      frontierProvider: fakeProvider('anthropic'),
      auditLogger,
      sessionId: 'override-session',
      getNextOverride: () => 'frontier',
    });
    await consume(router, baseReq);
    await auditLogger.close();
    const line = readFileSync(auditLogger.path, 'utf8').trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.userOverride).toBe('frontier');
    expect(entry.lane).toBe('frontier');
  });

  test('forwards the final AssistantMessage from the chosen child', async () => {
    const local = fakeProvider('ollama');
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: local,
      frontierProvider: fakeProvider('anthropic'),
    });
    const { final } = await consume(router, baseReq);
    expect(final.role).toBe('assistant');
    expect(final.content[0]?.type).toBe('text');
  });

  test('getNextOverride consumed once per stream() call', async () => {
    let calls = 0;
    const router = new RouterProvider({
      config: baseConfig,
      localProvider: fakeProvider('ollama'),
      frontierProvider: fakeProvider('anthropic'),
      getNextOverride: () => {
        calls++;
        return calls === 1 ? 'frontier' : undefined;
      },
    });
    const first = await consume(router, baseReq);
    const second = await consume(router, baseReq);
    const route1 = first.events.find((e) => e.type === 'route_decision');
    const route2 = second.events.find((e) => e.type === 'route_decision');
    if (route1?.type !== 'route_decision' || route2?.type !== 'route_decision') {
      throw new Error('missing route_decision');
    }
    expect(route1.info.lane).toBe('frontier');
    expect(route2.info.lane).toBe('local');
  });
});
