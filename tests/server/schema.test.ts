import { describe, expect, test } from 'bun:test';
import { ServerEventSchema, parseServerEvent } from '../../src/server/schema.js';

describe('ServerEventSchema', () => {
  test('parses a text_delta event', () => {
    const raw = {
      type: 'text_delta',
      seq: 1,
      sessionId: 's_abc',
      block: 0,
      text: 'Hello',
    };
    const parsed = ServerEventSchema.parse(raw);
    expect(parsed.type).toBe('text_delta');
    if (parsed.type !== 'text_delta') throw new Error('narrowing failed');
    expect(parsed.text).toBe('Hello');
    expect(parsed.seq).toBe(1);
  });

  test('parses a turn_complete event', () => {
    const raw = {
      type: 'turn_complete',
      seq: 42,
      sessionId: 's_abc',
      finishReason: 'end_turn',
    };
    const parsed = ServerEventSchema.parse(raw);
    expect(parsed.type).toBe('turn_complete');
  });

  test('rejects unknown event types', () => {
    expect(() => ServerEventSchema.parse({ type: 'mystery', seq: 0, sessionId: 's' })).toThrow();
  });

  test('parseServerEvent returns null for invalid JSON', () => {
    expect(parseServerEvent('{not json')).toBeNull();
  });

  test('parseServerEvent returns the parsed event for valid JSON', () => {
    const json = JSON.stringify({
      type: 'text_delta',
      seq: 1,
      sessionId: 's',
      block: 0,
      text: 'x',
    });
    const ev = parseServerEvent(json);
    expect(ev?.type).toBe('text_delta');
  });
});
