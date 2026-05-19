// M11.5 T3 — /model emits pickerOpen via ctx.requestPicker in server mode.
//
// REPL surface continues to use the in-process pick() flow (no
// requestPicker on its CommandContext); these tests pin the new
// server-mode branch without touching the legacy path.

import { describe, expect, test } from 'bun:test';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import type { PickerOpenConfig } from '../../src/commands/types.js';
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
