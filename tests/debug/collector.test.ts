import { describe, expect, test } from 'bun:test';
import { createDebugCollector } from '../../packages/sdk/src/debug/collector.js';

const AT = new Date('2026-08-04T10:00:00.000Z');

function collector(overrides: Parameters<typeof createDebugCollector>[0] = {}) {
  return createDebugCollector({ now: () => AT, ...overrides });
}

const dispatch = (principal: string, sessionId = 's1') => ({
  principal,
  sessionId,
  surface: 'chat',
  lane: 'chat',
  model: 'glm-5.2',
  text: 'tailor my resume for the staff role',
});

describe('dispatch feed', () => {
  test('records a turn and returns it newest-first', () => {
    const debug = collector();

    debug.record(dispatch('acct-1'));
    debug.record({ ...dispatch('acct-1'), model: 'sonnet-5' });

    const feed = debug.feedFor('acct-1');
    expect(feed.map((event) => event.model)).toEqual(['sonnet-5', 'glm-5.2']);
  });

  test('truncates the preview rather than storing a whole message', () => {
    const debug = collector();

    debug.record({ ...dispatch('acct-1'), text: 'x'.repeat(500) });

    expect(debug.feedFor('acct-1')[0]?.preview.length).toBe(80);
  });

  test('an unknown principal gets an empty feed, not an error', () => {
    expect(collector().feedFor('nobody')).toEqual([]);
  });

  test('keeps principals separate', () => {
    const debug = collector();

    debug.record(dispatch('acct-1'));
    debug.record(dispatch('acct-2'));

    expect(debug.feedFor('acct-1')).toHaveLength(1);
    expect(debug.feedFor('acct-2')).toHaveLength(1);
  });
});

describe('bounded by construction', () => {
  test('the per-principal ring drops the oldest, not the newest', () => {
    const debug = collector({ eventsPerPrincipal: 3 });

    for (const model of ['a', 'b', 'c', 'd']) {
      debug.record({ ...dispatch('acct-1'), model });
    }

    expect(debug.feedFor('acct-1').map((e) => e.model)).toEqual(['d', 'c', 'b']);
  });

  test('the principal LRU evicts the LEAST RECENTLY USED, not the oldest-created', () => {
    const debug = collector({ maxPrincipals: 2 });
    debug.record(dispatch('acct-1'));
    debug.record(dispatch('acct-2'));

    // Touching acct-1 makes acct-2 the least recent...
    debug.record(dispatch('acct-1'));
    debug.record(dispatch('acct-3'));

    expect(debug.feedFor('acct-1')).toHaveLength(2);
    expect(debug.feedFor('acct-2')).toEqual([]); // ...so acct-2 is the one evicted
    expect(debug.feedFor('acct-3')).toHaveLength(1);
  });
});

describe('the replay guard', () => {
  test('a REPLAYED event is not re-recorded', () => {
    // A metering follower re-streams session history on every turn. Without the
    // watermark each replay re-records every old event and the real turn is
    // lost among the duplicates.
    const debug = collector();
    const detail = { sessionId: 's1', kind: 'tool_call', tool: 'Bash', eventSeq: 5 } as const;

    debug.recordDetail('acct-1', detail);
    debug.recordDetail('acct-1', detail);
    debug.recordDetail('acct-1', { ...detail, eventSeq: 4 });

    expect(debug.detailsFor('acct-1')).toHaveLength(1);
  });

  test('an event BEYOND the watermark is genuinely new', () => {
    const debug = collector();

    debug.recordDetail('acct-1', { sessionId: 's1', kind: 'tool_call', tool: 'Bash', eventSeq: 5 });
    debug.recordDetail('acct-1', { sessionId: 's1', kind: 'tool_call', tool: 'Read', eventSeq: 6 });

    expect(debug.detailsFor('acct-1')).toHaveLength(2);
  });

  test('watermarks are PER SESSION — a new session starts clean', () => {
    const debug = collector();

    debug.recordDetail('acct-1', { sessionId: 's1', kind: 'tool_call', tool: 'Bash', eventSeq: 9 });
    debug.recordDetail('acct-1', { sessionId: 's2', kind: 'tool_call', tool: 'Read', eventSeq: 1 });

    // A low seq in a different session is not a replay.
    expect(debug.detailsFor('acct-1')).toHaveLength(2);
  });
});

describe('telemetry', () => {
  test('caps name and detail', () => {
    const debug = collector();

    debug.recordTelemetry({
      principal: 'acct-1',
      category: 'api',
      name: 'n'.repeat(500),
      detail: 'd'.repeat(500),
    });

    const row = debug.telemetryFor('acct-1')[0];
    expect(row?.name.length).toBe(200);
    expect(row?.detail.length).toBe(200);
  });

  test('forwards to the durability sink after the ring push', () => {
    const seen: string[] = [];
    const debug = collector({
      onTelemetry: (principal, event) => seen.push(`${principal}:${event.name}`),
    });

    debug.recordTelemetry({ principal: 'acct-1', category: 'api', name: 'GET /jobs' });

    expect(seen).toEqual(['acct-1:GET /jobs']);
  });

  test('A THROWING SINK NEVER REACHES THE CALLER', () => {
    // The never-fail contract outranks any sink: debug capture must not be able
    // to fail the request it is observing.
    const debug = collector({
      onTelemetry: () => {
        throw new Error('persister down');
      },
    });

    expect(() =>
      debug.recordTelemetry({ principal: 'acct-1', category: 'api', name: 'GET /jobs' }),
    ).not.toThrow();
    expect(debug.telemetryFor('acct-1')).toHaveLength(1);
  });
});
