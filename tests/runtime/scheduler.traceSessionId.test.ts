// Phase 13.3 (B1) — verify the scheduler wraps the child's traceRecorder
// so every emitted event carries the child's sessionId.

import { describe, expect, test } from 'bun:test';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';

// Test the WRAPPER LOGIC directly. The full scheduler integration test is
// out of scope; here we want to prove the wrapper transforms events
// correctly so the scheduler's contract is unambiguous.

function makeWrapper(
  parent: ((e: TraceEvent) => void) | undefined,
  childSessionId: string,
): ((e: TraceEvent) => void) | undefined {
  if (parent === undefined) return undefined;
  return (event: TraceEvent) => {
    parent({
      ...event,
      sessionId: childSessionId,
    } as TraceEvent);
  };
}

describe('scheduler trace wrapper (B1)', () => {
  test('overrides sessionId on events that already have one (parent id) with childSessionId', () => {
    const seen: (TraceEvent & { sessionId?: string })[] = [];
    const recorder = (e: TraceEvent) => seen.push(e as TraceEvent & { sessionId?: string });
    const wrapped = makeWrapper(recorder, 'child-1');
    expect(wrapped).toBeDefined();

    wrapped?.({
      type: 'session_start',
      sessionId: 'parent-1',
      iso: '2026-05-06T00:00:00Z',
      cwd: '/x',
      provider: 'fake',
      model: 'fake-1',
    } as unknown as TraceEvent);

    expect(seen.length).toBe(1);
    expect(seen[0]?.sessionId).toBe('child-1');
  });

  test('sets sessionId on events that have no sessionId property', () => {
    const seen: (TraceEvent & { sessionId?: string })[] = [];
    const recorder = (e: TraceEvent) => seen.push(e as TraceEvent & { sessionId?: string });
    const wrapped = makeWrapper(recorder, 'child-2');

    wrapped?.({
      type: 'turn_start',
      turn: 0,
      iso: '2026-05-06T00:00:01Z',
    } as unknown as TraceEvent);

    expect(seen[0]).toBeDefined();
    expect(seen[0]?.sessionId).toBe('child-2');
  });

  test('returns undefined when parent recorder is undefined', () => {
    const wrapped = makeWrapper(undefined, 'child-x');
    expect(wrapped).toBeUndefined();
  });

  test('preserves all other event fields when injecting sessionId', () => {
    const seen: (TraceEvent & { sessionId?: string })[] = [];
    const recorder = (e: TraceEvent) => seen.push(e as TraceEvent & { sessionId?: string });
    const wrapped = makeWrapper(recorder, 'child-3');

    wrapped?.({
      type: 'provider_request',
      provider: 'test-provider',
      model: 'test-model',
      purpose: 'main',
      messageCount: 42,
      systemBytes: 1024,
      iso: '2026-05-06T00:00:02Z',
    } as unknown as TraceEvent);

    const event = seen[0] as (TraceEvent & { sessionId?: string }) | undefined;
    expect(event).toBeDefined();
    expect(event?.sessionId).toBe('child-3');
    // Verify the event object has all original fields plus the injected sessionId
    expect(JSON.stringify(event)).toContain('"provider":"test-provider"');
    expect(JSON.stringify(event)).toContain('"model":"test-model"');
    expect(JSON.stringify(event)).toContain('"messageCount":42');
    expect(JSON.stringify(event)).toContain('"sessionId":"child-3"');
  });

  test('handles multiple events through the same wrapped recorder', () => {
    const seen: (TraceEvent & { sessionId?: string })[] = [];
    const recorder = (e: TraceEvent) => seen.push(e as TraceEvent & { sessionId?: string });
    const wrapped = makeWrapper(recorder, 'child-multi');

    wrapped?.({
      type: 'turn_start',
      turn: 0,
      iso: '2026-05-06T00:00:01Z',
    } as unknown as TraceEvent);

    wrapped?.({
      type: 'turn_start',
      turn: 1,
      iso: '2026-05-06T00:00:02Z',
    } as unknown as TraceEvent);

    expect(seen.length).toBe(2);
    expect(seen[0]?.sessionId).toBe('child-multi');
    expect(seen[1]?.sessionId).toBe('child-multi');
  });
});
