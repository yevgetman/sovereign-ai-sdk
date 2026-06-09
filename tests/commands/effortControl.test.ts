// Slice C (T6) — /effort slash command. The user-facing surface for the
// reasoning-depth feature. Mirrors the /model picker tests
// (pickers.requestPicker.test.ts): assert the explicit-arg apply path, the
// unsupported-model notice, the no-arg pickerOpen branch, /effort status, the
// invalid-arg path, and registry membership.
//
// ctx is the real shared CommandContext stub (_makeCtx.ts) wired through the
// real dispatchSlashCommand registry — the same way the picker tests construct
// their context — so these exercise the registered command end-to-end.

import { describe, expect, test } from 'bun:test';
import { COMMAND_REGISTRY, dispatchSlashCommand } from '../../src/commands/registry.js';
import type { PickerOpenConfig } from '../../src/commands/types.js';
import type { ReasoningEffort } from '../../src/providers/effort.js';
import { makeCtx } from './_makeCtx.js';

describe('/effort — explicit level applies immediately', () => {
  test('/effort high → setEffort("high") + confirmation, no notice on a reasoning model', async () => {
    const captured: { level: ReasoningEffort | null } = { level: null };
    const ctx = makeCtx({
      // claude-sonnet-4-6 under anthropic supports reasoning.
      model: 'claude-sonnet-4-6',
      apiMode: 'anthropic',
      setEffort: (level) => {
        captured.level = level;
      },
    });

    const result = await dispatchSlashCommand('/effort high', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.level).toBe('high');
    expect(result.output).toBe('effort set to high (reasoning depth for this session).');
    // No unsupported-model notice for a reasoning model.
    expect(result.output).not.toContain("doesn't support reasoning depth");
  });

  test('every valid level is accepted and forwarded to setEffort', async () => {
    for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
      const captured: { level: ReasoningEffort | null } = { level: null };
      const ctx = makeCtx({
        setEffort: (next) => {
          captured.level = next;
        },
      });
      const result = await dispatchSlashCommand(`/effort ${level}`, ctx);
      if (result.kind !== 'local') throw new Error('expected local');
      expect(captured.level).toBe(level);
      expect(result.output).toContain(`effort set to ${level}`);
    }
  });

  test('the effortChanged side-effect is emitted through the real setEffort wiring', async () => {
    // Build a ctx whose setEffort mirrors the server builder: mutate a live
    // field and record the change. This proves the command drives the
    // documented side-effect path (the runtime mutation IS the effect; the
    // record is the TUI chrome signal). State is held on an object (not a
    // narrowed local) so the post-dispatch reads stay typed as ReasoningEffort.
    const state: { live: ReasoningEffort; effortChanged?: ReasoningEffort } = { live: 'off' };
    const ctx = makeCtx({
      get effort() {
        return state.live;
      },
      setEffort: (level) => {
        state.live = level;
        state.effortChanged = level;
      },
    });

    const result = await dispatchSlashCommand('/effort medium', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(state.live).toBe('medium');
    expect(state.effortChanged).toBe('medium');
  });
});

describe('/effort — unsupported-model notice', () => {
  test('non-reasoning openai model (gpt-4o) ⇒ notice appended', async () => {
    const captured: { level: ReasoningEffort | null } = { level: null };
    const ctx = makeCtx({
      model: 'gpt-4o',
      apiMode: 'openai',
      providerName: 'openai',
      setEffort: (level) => {
        captured.level = level;
      },
    });

    const result = await dispatchSlashCommand('/effort high', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    // Still applies — the level is set even though the model ignores it.
    expect(captured.level).toBe('high');
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('effort set to high (reasoning depth for this session).');
    expect(result.output).toContain(
      "note: gpt-4o doesn't support reasoning depth — no effect until you switch to a reasoning model.",
    );
  });

  test('non-reasoning anthropic model (claude-3-5-haiku) ⇒ notice appended', async () => {
    const ctx = makeCtx({
      model: 'claude-3-5-haiku-20241022',
      apiMode: 'anthropic',
    });

    const result = await dispatchSlashCommand('/effort low', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('effort set to low');
    expect(result.output).toContain("claude-3-5-haiku-20241022 doesn't support reasoning depth");
  });

  test('reasoning model (claude-sonnet-4-6) ⇒ NO notice', async () => {
    const ctx = makeCtx({ model: 'claude-sonnet-4-6', apiMode: 'anthropic' });
    const result = await dispatchSlashCommand('/effort max', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('effort set to max (reasoning depth for this session).');
    expect(result.output).not.toContain("doesn't support");
  });
});

describe('/effort — no-arg opens the picker', () => {
  test('no-arg + requestPicker defined emits pickerOpen with the 5 levels', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      model: 'claude-sonnet-4-6',
      apiMode: 'anthropic',
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/effort', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toBe('');
    expect(captured.payload).not.toBeNull();

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.title).toBe('reasoning depth');
    // Re-dispatch path: selecting an item dispatches `/effort <level>`.
    expect(payload.onSelect).toEqual({ command: 'effort' });
    const values = payload.items.map((i) => i.value);
    expect(values).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });

  test('the current level is marked + is the initial selection', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      effort: 'high',
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/effort', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    const payload = captured.payload as PickerOpenConfig;
    const current = payload.items.find((i) => i.value === 'high');
    expect(current?.hint).toBe('(current)');
    const off = payload.items.find((i) => i.value === 'off');
    expect(off?.hint).toBeUndefined();
    // initial index points at the current level.
    expect(payload.initial).toBe(payload.items.findIndex((i) => i.value === 'high'));
  });

  test('subtitle reflects the current level + the active model support state', async () => {
    const captured: { payload: PickerOpenConfig | null } = { payload: null };
    const ctx = makeCtx({
      effort: 'low',
      model: 'gpt-4o',
      apiMode: 'openai',
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    await dispatchSlashCommand('/effort', ctx);

    const payload = captured.payload as PickerOpenConfig;
    expect(payload.subtitle).toContain('current: low');
    expect(payload.subtitle).toContain("gpt-4o can't reason");
  });

  test('no-arg + requestPicker undefined (REPL surface) falls back to status report, no mutation', async () => {
    const captured: { level: ReasoningEffort | null } = { level: null };
    const ctx = makeCtx({
      effort: 'medium',
      model: 'claude-sonnet-4-6',
      apiMode: 'anthropic',
      setEffort: (level) => {
        captured.level = level;
      },
    });

    const result = await dispatchSlashCommand('/effort', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.level).toBeNull(); // no mutation
    expect(result.output).toContain('effort: medium');
    expect(result.output).toContain('claude-sonnet-4-6 supports reasoning depth');
  });
});

describe('/effort status — non-interactive report without mutation', () => {
  test('/effort status shows the current level + support, never opens a picker, never mutates', async () => {
    const captured: { level: ReasoningEffort | null; payload: PickerOpenConfig | null } = {
      level: null,
      payload: null,
    };
    const ctx = makeCtx({
      effort: 'low',
      model: 'claude-sonnet-4-6',
      apiMode: 'anthropic',
      setEffort: (level) => {
        captured.level = level;
      },
      requestPicker: (config) => {
        captured.payload = config;
      },
    });

    const result = await dispatchSlashCommand('/effort status', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.level).toBeNull();
    expect(captured.payload).toBeNull();
    expect(result.output).toContain('effort: low (reasoning depth for this session).');
    expect(result.output).toContain('claude-sonnet-4-6 supports reasoning depth.');
  });

  test('/effort current is an alias of status (no mutation, no picker)', async () => {
    const captured: { level: ReasoningEffort | null } = { level: null };
    const ctx = makeCtx({
      effort: 'off',
      model: 'gpt-4o',
      apiMode: 'openai',
      setEffort: (level) => {
        captured.level = level;
      },
      requestPicker: () => {
        throw new Error('picker should not open for /effort current');
      },
    });

    const result = await dispatchSlashCommand('/effort current', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.level).toBeNull();
    expect(result.output).toContain('effort: off');
    expect(result.output).toContain('gpt-4o does not support reasoning depth');
  });
});

describe('/effort — invalid arg returns usage without mutating', () => {
  test('unknown level returns the usage string and does not call setEffort', async () => {
    const captured: { level: ReasoningEffort | null } = { level: null };
    const ctx = makeCtx({
      setEffort: (level) => {
        captured.level = level;
      },
    });

    const result = await dispatchSlashCommand('/effort turbo', ctx);

    if (result.kind !== 'local') throw new Error('expected local');
    expect(captured.level).toBeNull();
    expect(result.output).toContain('unknown effort level: turbo');
    expect(result.output).toContain('/effort [off|low|medium|high|max]');
  });
});

describe('/effort — registry membership', () => {
  test('the registry resolves /effort to a local command', () => {
    const cmd = COMMAND_REGISTRY.get('effort');
    expect(cmd).toBeDefined();
    expect(cmd?.type).toBe('local');
    expect(cmd?.name).toBe('effort');
    expect(cmd?.usage).toBe('/effort [off|low|medium|high|max]');
  });

  test('/help lists the effort command', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlashCommand('/help', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('/effort');
  });
});
