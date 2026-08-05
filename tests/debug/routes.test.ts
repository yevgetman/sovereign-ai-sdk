import { describe, expect, test } from 'bun:test';
import { createDebugCollector } from '../../packages/sdk/src/debug/collector.js';
import {
  type DebugRouteOptions,
  createDebugRouteHandlers,
} from '../../packages/sdk/src/debug/routes.js';

const CONTEXT = { principal: 'acct-1' };

function handlers(overrides: Partial<DebugRouteOptions> = {}) {
  const collector = createDebugCollector({ now: () => new Date('2026-08-04T10:00:00.000Z') });
  return {
    collector,
    routes: createDebugRouteHandlers({ collector, isPermitted: () => true, ...overrides }),
  };
}

describe('the permission gate', () => {
  test('refuses every surface when the host says no', async () => {
    const { routes } = handlers({ isPermitted: () => false, dataSource: () => [] });

    for (const response of [
      await routes.feed(CONTEXT),
      await routes.telemetry(CONTEXT),
      await routes.data(CONTEXT),
      await routes.event(CONTEXT, { name: 'nav' }),
    ]) {
      expect(response.status).toBe(404);
    }
  });

  test('A CHECK THAT THROWS REFUSES — it does not grant', async () => {
    // The difference between an outage and a disclosure.
    const { routes } = handlers({
      isPermitted: () => {
        throw new Error('session store down');
      },
    });

    expect((await routes.feed(CONTEXT)).status).toBe(404);
  });

  test('a rejected async check also refuses', async () => {
    const { routes } = handlers({ isPermitted: async () => Promise.reject(new Error('nope')) });

    expect((await routes.feed(CONTEXT)).status).toBe(404);
  });

  test('a host can choose an explicit 403 instead of a silent 404', async () => {
    const { routes } = handlers({ isPermitted: () => false, refusalStatus: 403 });

    expect((await routes.feed(CONTEXT)).status).toBe(403);
  });

  test('the permission check receives the FULL context, not just the principal', async () => {
    let seen: unknown;
    const { routes } = handlers({
      isPermitted: (context) => {
        seen = context;
        return true;
      },
    });

    await routes.feed({ principal: 'acct-1', roles: ['debugger'], ip: '10.0.0.2' });

    expect(seen).toMatchObject({ principal: 'acct-1', roles: ['debugger'], ip: '10.0.0.2' });
  });
});

describe('feed', () => {
  test('returns the principal’s turns and details', async () => {
    const { collector, routes } = handlers();
    collector.record({ principal: 'acct-1', sessionId: 's1', surface: 'chat', model: 'glm-5.2' });
    collector.recordDetail('acct-1', {
      sessionId: 's1',
      kind: 'tool_call',
      tool: 'Bash',
      eventSeq: 1,
    });

    const response = await routes.feed(CONTEXT);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ currentSessionId: null });
    const body = response.body as { events: unknown[]; details: unknown[] };
    expect(body.events).toHaveLength(1);
    expect(body.details).toHaveLength(1);
  });

  test('carries the host’s live session id when it tracks one', async () => {
    const { routes } = handlers({ currentSessionId: () => 'sess-live' });

    expect((await routes.feed(CONTEXT)).body).toMatchObject({ currentSessionId: 'sess-live' });
  });

  test('caps rows so a long-running session cannot return an unbounded payload', async () => {
    const { collector, routes } = handlers({ limit: 2 });
    for (let index = 0; index < 5; index += 1) {
      collector.record({ principal: 'acct-1', sessionId: 's1', surface: 'chat', model: 'm' });
    }

    expect((await routes.feed(CONTEXT)).body).toMatchObject({ events: expect.any(Array) });
    expect(((await routes.feed(CONTEXT)).body as { events: unknown[] }).events).toHaveLength(2);
  });
});

describe('data', () => {
  test('NO SOURCE MEANS ABSENT, not empty', async () => {
    // Returning [] would tell the console "nothing has changed", which is a
    // different and false claim from "this host has no data vocabulary".
    const { routes } = handlers();

    expect((await routes.data(CONTEXT)).status).toBe(404);
  });

  test('returns the host’s rows when a source is supplied', async () => {
    const { routes } = handlers({
      dataSource: () => [{ at: '2026-08-04T10:00:00.000Z', summary: 'commit abc', seq: 1 }],
    });

    const response = await routes.data(CONTEXT);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([{ summary: 'commit abc' }]);
  });
});

describe('event', () => {
  test('records a client-reported navigation', async () => {
    const { collector, routes } = handlers();

    const response = await routes.event(CONTEXT, { name: 'nav /resume → /jobs', detail: '/jobs' });

    expect(response.status).toBe(204);
    expect(collector.telemetryFor('acct-1')).toMatchObject([
      { category: 'nav', name: 'nav /resume → /jobs', detail: '/jobs' },
    ]);
  });

  test('REJECTS A MALFORMED BODY rather than letting it reach the ring', async () => {
    const { collector, routes } = handlers();

    expect((await routes.event(CONTEXT, { name: 42 })).status).toBe(400);
    expect((await routes.event(CONTEXT, {})).status).toBe(400);
    expect(collector.telemetryFor('acct-1')).toHaveLength(0);
  });

  test('caps client-supplied strings', async () => {
    const { collector, routes } = handlers();

    await routes.event(CONTEXT, { name: 'n'.repeat(500), detail: 'd'.repeat(500) });

    const row = collector.telemetryFor('acct-1')[0];
    expect(row?.name.length).toBe(200);
    expect(row?.detail.length).toBe(200);
  });

  test('ignores a non-string detail instead of stringifying it', async () => {
    const { collector, routes } = handlers();

    await routes.event(CONTEXT, { name: 'nav', detail: { nested: true } });

    expect(collector.telemetryFor('acct-1')[0]?.detail).toBe('');
  });
});
