// M11.5 T3 + T7 — /model, /resume, /export emit pickerOpen via
// ctx.requestPicker in server mode.
//
// REPL surface continues to use the in-process pick() flow (no
// requestPicker on its CommandContext); these tests pin the new
// server-mode branch without touching the legacy path.

import { describe, expect, test } from 'bun:test';
import type { PickerOpenConfig } from '@yevgetman/sov-sdk/commands/types';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { makeCtx } from './_makeCtx.js';

describe('/model — requestPicker branch (M11.5 T3)', () => {
  test('no-arg + requestPicker defined emits pickerOpen with expected shape', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/model', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('');
    expect(captured.payload).not.toBeNull();

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.title).toBe('switch model');
    expect(payload.subtitle).toBe('provider: anthropic');
    expect(payload.onSelect).toEqual({ command: 'model' });
    expect(payload.items.length).toBeGreaterThan(0);

    const sonnet = payload.items.find((i) => i.value === 'claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    expect(sonnet?.hint).toBe('(current)');

    const haiku = payload.items.find((i) => i.value === 'claude-haiku-4-5-20251001');
    expect(haiku).toBeDefined();
    expect(haiku?.hint).toBeUndefined();

    expect(payload.initial).toBe(payload.items.findIndex((i) => i.value === 'claude-sonnet-4-6'));
  });

  test('explicit arg + requestPicker defined skips picker and sets model', async () => {
    const captured: { payload: PickerOpenConfig | null; model: string | null } = {
      payload: null,
      model: null,
    };
    const ctx = makeCtx({
      setModel: (m: string) => {
        captured.model = m;
      },
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/model claude-opus-4-7', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.payload).toBeNull();
    expect(captured.model).toBe('claude-opus-4-7');
    expect(result.output).toContain('claude-opus-4-7');
    expect(result.output).toContain('persisted to session');
  });

  test('no-arg + requestPicker undefined falls through to legacy TTY-required message', async () => {
    // No requestPicker on the context — REPL surface behavior preserved.
    const ctx = makeCtx({ model: 'haiku' });
    const result = await dispatchSlashCommand('/model', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('current model: haiku');
    expect(result.output).toContain('requires a TTY');
  });

  test('no-arg + requestPicker defined + unknown provider returns "no preset models" without firing picker', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      providerName: 'mystery-provider',
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/model', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.payload).toBeNull();
    expect(result.output).toContain('no preset models registered');
  });
});

describe('/resume — requestPicker branch (M11.5 T7)', () => {
  function makeSessionEntry(overrides: { sessionId?: string; title?: string } = {}) {
    return {
      sessionId: overrides.sessionId ?? 'sess-aaa',
      parentSessionId: null,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      platform: 'darwin',
      createdAt: Math.floor(Date.now() / 1000) - 120,
      lastUpdated: Math.floor(Date.now() / 1000) - 60,
      title: overrides.title ?? 'a recorded session',
      ownerId: null,
      msgCount: 4,
      totalTokens: 200,
      totalCostUsd: 0.02,
    };
  }

  test('no-arg + requestPicker defined emits pickerOpen for /resume', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      listSessions: () => [
        makeSessionEntry({ sessionId: 'sess-aaa', title: 'session A' }),
        makeSessionEntry({ sessionId: 'sess-bbb', title: 'session B' }),
      ],
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/resume', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('');
    expect(captured.payload).not.toBeNull();

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.title).toBe('resume session');
    expect(payload.onSelect).toEqual({ command: 'resume' });
    expect(payload.items.length).toBe(2);
    expect(payload.items[0]?.value).toBe('sess-aaa');
    expect(payload.items[0]?.label).toContain('session A');
    expect(payload.items[0]?.hint).toContain('msg');
  });

  test('explicit session-id + requestPicker defined prints resume command and skips picker', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      listSessions: () => [makeSessionEntry({ sessionId: 'sess-target', title: 'pick me' })],
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/resume sess-target', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.payload).toBeNull();
    expect(result.output).toContain('selected session sess-tar');
    expect(result.output).toContain('sov --resume sess-target');
  });

  test('explicit session-id that does not match returns selection error', async () => {
    const ctx = makeCtx({
      listSessions: () => [makeSessionEntry({ sessionId: 'sess-aaa' })],
      requestPicker: () => {},
    });
    const result = await dispatchSlashCommand('/resume sess-nonexistent', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('selection error');
    expect(result.output).toContain('sess-nonexistent');
  });
});

describe('/export — requestPicker branch (M11.5 T7)', () => {
  const sampleMessages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ];

  test('no-arg + requestPicker defined emits pickerOpen for /export', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      getMessages: () => sampleMessages,
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/export', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('');
    expect(captured.payload).not.toBeNull();

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.title).toBe('export session');
    expect(payload.onSelect).toEqual({ command: 'export' });
    const values = payload.items.map((i) => i.value).sort();
    expect(values).toEqual(['json', 'jsonl', 'md']);
  });

  test('empty messages short-circuits before the picker', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      getMessages: () => [],
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/export', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.payload).toBeNull();
    expect(result.output).toContain('nothing to export');
  });
});

describe('/theme — requestPicker + themeChanged (backlog #46)', () => {
  test('no-arg + requestPicker defined emits pickerOpen for /theme', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/theme', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('');
    expect(captured.payload).not.toBeNull();

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.title).toBe('switch theme');
    expect(payload.onSelect).toEqual({ command: 'theme' });
    expect(payload.items.length).toBeGreaterThan(0);
    // Built-ins should include at least dark + light.
    const values = payload.items.map((i) => i.value);
    expect(values).toContain('dark');
    expect(values).toContain('light');
  });

  test('explicit name + recordThemeChange defined records the side-effect', async () => {
    const captured: { name: string | null } = { name: null };
    const ctx = makeCtx({
      recordThemeChange: (name) => {
        captured.name = name;
      },
    });

    const result = await dispatchSlashCommand('/theme light', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.name).toBe('light');
    expect(result.output.toLowerCase()).toContain('light');
  });

  test('unknown name does not record themeChanged', async () => {
    const captured: { name: string | null } = { name: null };
    const ctx = makeCtx({
      recordThemeChange: (name) => {
        captured.name = name;
      },
    });

    const result = await dispatchSlashCommand('/theme nonsense', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.name).toBeNull();
    expect(result.output).toContain('unknown theme');
  });

  test('explicit name + recordThemeChange undefined (REPL surface) still applies', async () => {
    // No recordThemeChange on ctx — applyAndPersistTheme still runs;
    // no side-effect emission is the only difference.
    const ctx = makeCtx({});
    const result = await dispatchSlashCommand('/theme dark', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output.toLowerCase()).toContain('dark');
  });
});
