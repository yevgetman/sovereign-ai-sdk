import { describe, expect, test } from 'bun:test';
import {
  CommandSideEffectsSchema,
  InputOpenConfigSchema,
  PickerOpenConfigSchema,
  PickerOpenItemSchema,
  ServerEventSchema,
  parseServerEvent,
} from '../../src/server/schema.js';

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

describe('PickerOpenItemSchema (2026-05-24 config UX extension)', () => {
  test('parses the M11.5 baseline shape (label/value/hint only)', () => {
    const parsed = PickerOpenItemSchema.parse({
      label: 'claude-haiku-4-5',
      value: 'claude-haiku-4-5',
      hint: 'fastest tier',
    });
    expect(parsed.valueColumn).toBeUndefined();
    expect(parsed.badge).toBeUndefined();
  });

  test('parses the config-row shape with valueColumn + badge=live', () => {
    const parsed = PickerOpenItemSchema.parse({
      label: 'defaultModel',
      value: 'defaultModel',
      valueColumn: 'claude-haiku-4-5-20251001',
      badge: 'live',
    });
    expect(parsed.valueColumn).toBe('claude-haiku-4-5-20251001');
    expect(parsed.badge).toBe('live');
  });

  test('parses the config-row shape with badge=reload', () => {
    const parsed = PickerOpenItemSchema.parse({
      label: 'taskRouting.enabled',
      value: 'taskRouting.enabled',
      valueColumn: 'false',
      badge: 'reload',
    });
    expect(parsed.badge).toBe('reload');
  });

  test('rejects badge values outside the enum', () => {
    expect(() =>
      PickerOpenItemSchema.parse({
        label: 'x',
        value: 'x',
        badge: 'maybe',
      }),
    ).toThrow();
  });

  test('still parses a full picker config with mixed extended + baseline items', () => {
    const cfg = PickerOpenConfigSchema.parse({
      title: 'config',
      items: [
        { label: 'general', value: 'general' },
        { label: 'theme', value: 'theme', valueColumn: 'dark', badge: 'live' },
      ],
      onSelect: { command: 'config' },
    });
    expect(cfg.items).toHaveLength(2);
    expect(cfg.items[0]?.valueColumn).toBeUndefined();
    expect(cfg.items[1]?.valueColumn).toBe('dark');
  });
});

describe('InputOpenConfigSchema (2026-05-24)', () => {
  test('parses the minimum viable shape', () => {
    const parsed = InputOpenConfigSchema.parse({
      title: 'providers.anthropic.apiKey',
      onSubmit: { command: 'config set providers.anthropic.apiKey' },
    });
    expect(parsed.title).toBe('providers.anthropic.apiKey');
    expect(parsed.masked).toBeUndefined();
  });

  test('parses the full shape with subtitle/initial/placeholder/masked', () => {
    const parsed = InputOpenConfigSchema.parse({
      title: 'providers.anthropic.apiKey',
      subtitle: 'Stored at ~/.harness/config.json',
      initial: '',
      placeholder: 'sk-ant-...',
      masked: true,
      onSubmit: { command: 'config set providers.anthropic.apiKey' },
    });
    expect(parsed.masked).toBe(true);
    expect(parsed.placeholder).toBe('sk-ant-...');
  });

  test('rejects a missing onSubmit', () => {
    expect(() => InputOpenConfigSchema.parse({ title: 'x' } as unknown)).toThrow();
  });
});

describe('CommandSideEffectsSchema (2026-05-24 inputOpen + verboseChanged)', () => {
  test('parses the empty side-effects envelope', () => {
    const parsed = CommandSideEffectsSchema.parse({});
    expect(parsed.inputOpen).toBeUndefined();
    expect(parsed.verboseChanged).toBeUndefined();
  });

  test('parses a side-effects envelope with inputOpen', () => {
    const parsed = CommandSideEffectsSchema.parse({
      inputOpen: {
        title: 'maxTurns',
        onSubmit: { command: 'config set maxTurns' },
      },
    });
    expect(parsed.inputOpen?.title).toBe('maxTurns');
  });

  test('parses a side-effects envelope with verboseChanged=true', () => {
    const parsed = CommandSideEffectsSchema.parse({ verboseChanged: true });
    expect(parsed.verboseChanged).toBe(true);
  });

  test('parses a side-effects envelope with both inputOpen and pickerOpen present', () => {
    // Both can be set when /config set returns the parent-menu picker
    // alongside an inputOpen for the next edit (unusual but not invalid).
    const parsed = CommandSideEffectsSchema.parse({
      inputOpen: {
        title: 'maxTurns',
        onSubmit: { command: 'config set maxTurns' },
      },
      pickerOpen: {
        title: 'config / general',
        items: [],
        onSelect: { command: 'config edit' },
      },
    });
    expect(parsed.inputOpen).toBeDefined();
    expect(parsed.pickerOpen).toBeDefined();
  });
});
