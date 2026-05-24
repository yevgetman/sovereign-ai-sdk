// Slash dispatcher tests for /config. Covers each verb (no-args /
// group-id / edit / set / unset / show / path / get), error paths,
// secret display masking, live/reload badge logic, parent-refresh
// after a successful set/unset, and the unmanaged-keys safety net.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchConfigCommand } from '../../src/commands/configOps.js';
import type {
  CommandContext,
  InputOpenConfig,
  PickerOpenConfig,
} from '../../src/commands/types.js';
import { __resetAllDrafts } from '../../src/config/draftManager.js';
import { makeCtx } from './_makeCtx.js';

type Capture = {
  pickers: PickerOpenConfig[];
  inputs: InputOpenConfig[];
  themeChanges: string[];
  verboseChanges: boolean[];
  closeModalCount: number;
  rebuildTaskRoutingCount: number;
};

function captureCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  cap: Capture;
} {
  const cap: Capture = {
    pickers: [],
    inputs: [],
    themeChanges: [],
    verboseChanges: [],
    closeModalCount: 0,
    rebuildTaskRoutingCount: 0,
  };
  const ctx = makeCtx({
    requestPicker: (p) => {
      cap.pickers.push(p);
    },
    requestInput: (i) => {
      cap.inputs.push(i);
    },
    recordThemeChange: (n) => {
      cap.themeChanges.push(n);
    },
    recordVerboseChange: (v) => {
      cap.verboseChanges.push(v);
    },
    requestCloseModal: () => {
      cap.closeModalCount += 1;
    },
    rebuildTaskRouting: async () => {
      cap.rebuildTaskRoutingCount += 1;
    },
    ...overrides,
  });
  return { ctx, cap };
}

describe('/config dispatcher', () => {
  let dir: string;
  let cfgPath: string;
  const prevEnv = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cfg-ops-'));
    cfgPath = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = cfgPath;
    // 2026-05-24 patch — drafts persist across dispatches per sessionId.
    // Reset between tests so they don't bleed (makeCtx uses a fixed
    // sessionId of 'session-1').
    __resetAllDrafts();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevEnv;
    __resetAllDrafts();
  });

  describe('no args → root menu', () => {
    test('emits a pickerOpen with all root groups', async () => {
      const { ctx, cap } = captureCtx();
      const result = await dispatchConfigCommand('', ctx);
      expect(result).toBe('');
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      expect(picker).toBeDefined();
      if (!picker) return;
      expect(picker.title).toBe('config');
      expect(picker.items.length).toBeGreaterThan(5);
      // Verify a few key groups are present.
      const labels = picker.items.map((i) => i.label);
      expect(labels).toContain('General');
      expect(labels).toContain('Providers');
      expect(labels).toContain('Appearance');
    });

    test('appends Advanced (unmanaged) when settings contain unknown keys', async () => {
      // Write a config file with a top-level unmanaged key. Bypass schema
      // parse by writing the JSON directly — the schema is strict and
      // would reject the unknown key on read. listUnmanagedKeys consults
      // the parsed Settings object directly.
      const raw = JSON.stringify({ defaultProvider: 'anthropic' });
      writeFileSync(cfgPath, raw);
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const labels = picker.items.map((i) => i.label);
      // Without unmanaged keys, Advanced should NOT appear.
      expect(labels).not.toContain('Advanced (unmanaged)');
    });

    test('falls back to plain-text listing when ctx.requestPicker is undefined', async () => {
      // makeCtx doesn't include requestPicker by default; this scenario is
      // the REPL surface (no inline TUI picker capability).
      const ctx = makeCtx();
      // Sanity check: by default, _makeCtx does not provide requestPicker.
      expect(ctx.requestPicker).toBeUndefined();
      const result = await dispatchConfigCommand('', ctx);
      expect(result).toContain('config groups:');
      expect(result).toContain('general');
    });
  });

  describe('<group-id> → group submenu', () => {
    test('emits a pickerOpen with items in that group', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('general', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('config / general');
      // Items should reference dotpaths as values + carry badges.
      const values = picker.items.map((i) => i.value);
      expect(values).toContain('defaultProvider');
      expect(values).toContain('maxTurns');
    });

    test('items have a badge: live for defaultModel, reload for maxTurns', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('general', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const defaultModelItem = picker.items.find((i) => i.value === 'defaultModel');
      const maxTurnsItem = picker.items.find((i) => i.value === 'maxTurns');
      expect(defaultModelItem?.badge).toBe('live');
      expect(maxTurnsItem?.badge).toBe('reload');
    });

    test('value column reflects persisted value', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('general', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const item = picker.items.find((i) => i.value === 'defaultProvider');
      expect(item?.valueColumn).toBe('ollama');
    });

    test('secret items show masked bullets when set', async () => {
      await dispatchConfigCommand('set providers.anthropic.apiKey sk-test', makeCtx());
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('providers-anthropic', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const apiKey = picker.items.find((i) => i.value === 'providers.anthropic.apiKey');
      expect(apiKey?.valueColumn).toBe('••••••••');
    });

    test('secret items show (unset) when missing', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('providers-anthropic', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const apiKey = picker.items.find((i) => i.value === 'providers.anthropic.apiKey');
      expect(apiKey?.valueColumn).toBe('(unset)');
    });

    test('providers root emits a drill-in picker', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('providers', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const labels = picker.items.map((i) => i.label);
      expect(labels).toContain('Anthropic');
      expect(labels).toContain('OpenAI');
      // Drill-in items have no badges or valueColumns.
      for (const item of picker.items) {
        expect(item.badge).toBeUndefined();
      }
    });

    test('unknown group returns an error', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('nonexistent-group', ctx);
      expect(result).toContain('unknown /config verb');
    });
  });

  describe('edit <dotpath>', () => {
    test('boolean field emits picker with true/false', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit verbose', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const values = picker.items.map((i) => i.value);
      expect(values).toEqual(['true', 'false']);
      expect(picker.onSelect.command).toBe('config set verbose');
    });

    test('enum field emits picker with the choice list', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit permissionMode', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const values = picker.items.map((i) => i.value);
      expect(values).toEqual(['default', 'ask', 'bypass']);
      expect(picker.onSelect.command).toBe('config set permissionMode');
    });

    test('string field with choices emits picker (not inputOpen)', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit theme', ctx);
      expect(cap.inputs.length).toBe(0);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      const values = picker.items.map((i) => i.value);
      expect(values).toContain('dark');
      expect(values).toContain('light');
    });

    test('string field with dynamicChoices emits a picker scoped by defaultProvider', async () => {
      // 2026-05-24 patch — defaultModel now uses dynamicChoices so the
      // picker shows the active provider's known model list, plus a
      // "↪ type custom value…" sentinel. Default config has no
      // defaultProvider set, so modelsForProvider falls back to the
      // anthropic list.
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit defaultModel', ctx);
      expect(cap.pickers.length).toBe(1);
      expect(cap.inputs.length).toBe(0);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('defaultModel');
      const labels = picker.items.map((i) => i.label);
      expect(labels).toContain('claude-haiku-4-5-20251001');
      expect(labels).toContain('claude-sonnet-4-6');
      expect(labels).toContain('claude-opus-4-7');
      // Sentinel for custom-type must be present at the end.
      expect(labels).toContain('↪ type custom value…');
    });

    test('defaultModel picker scopes choices to the configured defaultProvider', async () => {
      // Seed defaultProvider = ollama; picker should show ollama models.
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit defaultModel', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const labels = picker.items.map((i) => i.label);
      expect(labels).toContain('qwen2.5:7b');
      expect(labels).toContain('llama3.1:8b');
      // Anthropic models should NOT appear.
      expect(labels).not.toContain('claude-opus-4-7');
    });

    test('defaultModel sentinel reroutes to inputOpen on submit', async () => {
      // Selecting the custom sentinel dispatches `config set defaultModel
      // <CUSTOM_SENTINEL>`; runSet should detect the sentinel and open
      // the inputCard instead of persisting the literal value.
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('set defaultModel __sov_config_type_custom__', ctx);
      expect(cap.inputs.length).toBe(1);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.title).toBe('defaultModel');
      expect(input.onSubmit.command).toBe('config set defaultModel');
    });

    test('number field emits inputOpen', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit maxTurns', ctx);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.title).toBe('maxTurns');
      expect(input.masked).toBeUndefined();
    });

    test('secret field emits inputOpen with masked: true and empty initial', async () => {
      await dispatchConfigCommand('set providers.openai.apiKey sk-test', makeCtx());
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit providers.openai.apiKey', ctx);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.masked).toBe(true);
      // Never echo the secret value back.
      expect(input.initial).toBeUndefined();
    });

    test('unknown dotpath returns a clear error', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('edit completely.unknown', ctx);
      expect(result).toContain('unknown config field');
    });

    test('missing dotpath returns usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('edit', ctx);
      expect(result).toContain('usage');
    });
  });

  describe('set <dotpath> <value>', () => {
    test('persists the value to disk', async () => {
      const { ctx } = captureCtx();
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
      expect(onDisk.defaultProvider).toBe('ollama');
    });

    test('returns a toast with the persisted-only message for a reload-needed field', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set defaultProvider ollama', ctx);
      expect(result).toContain('effective next session');
    });

    test('returns a toast with the applied message for a live-applyable field', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set defaultModel claude-opus-4-7', ctx);
      expect(result).toContain('applied to current session');
    });

    test('returns plain "saved" toast in sov config standalone mode', async () => {
      const { ctx } = captureCtx({ isConfigStandalone: true });
      const result = await dispatchConfigCommand('set defaultModel claude-opus-4-7', ctx);
      // Standalone mode never applies to a session.
      expect(result).toBe('saved');
    });

    test('schema validation failure returns a config error', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set permissionMode invalid-mode', ctx);
      expect(result).toContain('config error');
    });

    test('backspace navigation — root menu emits no onBack', async () => {
      // 2026-05-24 patch — back-navigation. Root menu has no parent.
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack).toBeUndefined();
    });

    test('backspace navigation — top-level group goes back to root', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('general', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack?.command).toBe('config');
    });

    test('backspace navigation — providers drill-in root goes back to root', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('providers', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack?.command).toBe('config');
    });

    test('backspace navigation — drill-in subgroup goes back to drill-in root', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('providers-anthropic', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack?.command).toBe('config providers');
    });

    test('backspace navigation — editor picker goes back to field group', async () => {
      const { ctx, cap } = captureCtx();
      // taskRouting.enabled is a boolean → editor is a picker.
      await dispatchConfigCommand('edit taskRouting.enabled', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack?.command).toBe('config task-routing');
    });

    test('backspace navigation — drill-in subgroup leaf editor goes back to subgroup', async () => {
      const { ctx, cap } = captureCtx();
      // providers.anthropic.model is in the providers-anthropic subgroup.
      await dispatchConfigCommand('edit providers.anthropic.model', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onBack?.command).toBe('config providers-anthropic');
    });

    test('re-opens the editor with preserved value when validation fails (enum)', async () => {
      // 2026-05-24 review #1 (HIGH) — invalid enum value triggers the
      // re-emit-editor-on-error path so the user can correct in place.
      const { ctx, cap } = captureCtx();
      const result = await dispatchConfigCommand('set permissionMode whatever', ctx);
      expect(result).toContain('config error');
      // A picker should have been re-emitted with the validation error
      // as subtitle and the user's typed value flagged.
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('permissionMode');
      expect(picker.subtitle).toMatch(/Validation failed/);
      expect(picker.onSelect.command).toBe('config set permissionMode');
    });

    test('re-opens the input editor with typed value when validation fails (number)', async () => {
      const { ctx, cap } = captureCtx();
      // maxTurns expects a positive int; -1 is rejected by schema.
      const result = await dispatchConfigCommand('set maxTurns -1', ctx);
      expect(result).toContain('config error');
      expect(cap.inputs.length).toBe(1);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.title).toBe('maxTurns');
      expect(input.subtitle).toMatch(/Validation failed/);
      // The typed value is preserved so the user can correct in place.
      expect(input.initial).toBe('-1');
    });

    test('setting defaultModel clears providers.<defaultProvider>.model override', async () => {
      // 2026-05-24 patch — defaultModel cascade fix. Without this,
      // changing defaultModel via /config has no effect because
      // providers.<x>.model shadows it in the cascade.
      // First: seed providers.anthropic.model = sonnet AND defaultModel = haiku.
      writeFileSync(
        cfgPath,
        JSON.stringify({
          defaultProvider: 'anthropic',
          defaultModel: 'claude-haiku-4-5-20251001',
          providers: { anthropic: { model: 'claude-sonnet-4-6' } },
        }),
      );
      const { ctx } = captureCtx();
      // Change defaultModel — expect the override to ALSO be cleared.
      const result = await dispatchConfigCommand('set defaultModel claude-opus-4-7', ctx);
      expect(result).toContain('cleared providers.anthropic.model');
      // Verify the on-disk state: defaultModel is the new value AND
      // providers.anthropic.model is gone.
      const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
      expect(after.defaultModel).toBe('claude-opus-4-7');
      expect(after.providers?.anthropic?.model).toBeUndefined();
    });

    test('setting defaultModel is a no-op on the override when no override is set', async () => {
      // When providers.<defaultProvider>.model isn't set, the cascade
      // fix path is a no-op — no spurious mention in the toast.
      writeFileSync(
        cfgPath,
        JSON.stringify({
          defaultProvider: 'anthropic',
          defaultModel: 'claude-haiku-4-5-20251001',
        }),
      );
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set defaultModel claude-sonnet-4-6', ctx);
      expect(result).not.toContain('cleared');
    });

    test('setting fields other than defaultModel does NOT touch the override', async () => {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          defaultProvider: 'anthropic',
          providers: { anthropic: { model: 'claude-sonnet-4-6' } },
        }),
      );
      const { ctx } = captureCtx();
      await dispatchConfigCommand('set defaultProvider anthropic', ctx);
      const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
      // The override stays intact when the user edits other fields.
      expect(after.providers?.anthropic?.model).toBe('claude-sonnet-4-6');
    });

    test('string fields accept numeric-looking input (review #5 — no over-coercion)', async () => {
      // 2026-05-24 review #5 — the legacy parseValueLiteral coerced
      // "42" → number, breaking string-typed fields. Setting
      // defaultModel to a numeric-looking string must persist as a
      // string, not get rejected as "expected string, received number".
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set defaultModel 42', ctx);
      expect(result).not.toContain('config error');
    });

    test('emits parent-group picker after successful set', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      // After a set, the parent group's picker should be emitted so the
      // TUI navigates back to it.
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('config / general');
      // The refreshed picker should show the new value.
      const item = picker.items.find((i) => i.value === 'defaultProvider');
      expect(item?.valueColumn).toBe('ollama');
    });

    test('records themeChange side-effect when setting theme', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('set theme light', ctx);
      expect(cap.themeChanges).toEqual(['light']);
    });

    test('records verboseChange side-effect when setting verbose', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('set verbose true', ctx);
      expect(cap.verboseChanges).toEqual([true]);
    });

    test('missing dotpath returns usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set', ctx);
      expect(result).toContain('usage');
    });

    test('missing value returns usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('set defaultProvider', ctx);
      expect(result).toContain('usage');
    });
  });

  describe('unset <dotpath>', () => {
    test('removes the value from disk', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx } = captureCtx();
      await dispatchConfigCommand('unset defaultProvider', ctx);
      const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
      expect(onDisk.defaultProvider).toBeUndefined();
    });

    test('returns a toast indicating success', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('unset defaultProvider', ctx);
      expect(result).toContain('unset');
    });

    test('emits parent-group picker after successful unset', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('unset defaultProvider', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('config / general');
    });

    test('missing dotpath returns usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('unset', ctx);
      expect(result).toContain('usage');
    });
  });

  describe('show / path / get (legacy verbs preserved)', () => {
    test('show returns JSON of redacted settings', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('show', ctx);
      expect(result).toContain('ollama');
      const parsed = JSON.parse(result);
      expect(parsed.defaultProvider).toBe('ollama');
    });

    test('show redacts secrets to ***', async () => {
      await dispatchConfigCommand('set providers.anthropic.apiKey sk-test', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('show', ctx);
      expect(result).toContain('***');
      expect(result).not.toContain('sk-test');
    });

    test('path returns the resolved config path', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('path', ctx);
      expect(result).toBe(cfgPath);
    });

    test('get returns the value at the dotpath', async () => {
      await dispatchConfigCommand('set defaultProvider ollama', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('get defaultProvider', ctx);
      expect(result).toBe('ollama');
    });

    test('get redacts secrets', async () => {
      await dispatchConfigCommand('set providers.anthropic.apiKey sk-test', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('get providers.anthropic.apiKey', ctx);
      expect(result).toBe('***');
    });

    test('get with no dotpath returns usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('get', ctx);
      expect(result).toContain('usage');
    });
  });

  describe('advanced (unmanaged) group', () => {
    test('emits an empty message when no unmanaged keys exist', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('advanced', ctx);
      expect(result).toContain('no unmanaged');
    });
  });

  describe('unknown verb', () => {
    test('returns a clear error and usage', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('flibbertigibbet', ctx);
      expect(result).toContain('unknown /config verb');
    });
  });

  // 2026-05-24 Phase 2.5 — preset verbs.
  describe('preset verbs', () => {
    test('/config preset opens a picker with built-in presets', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('preset', ctx);
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      const values = picker.items.map((i) => i.value);
      expect(values).toContain('frugal-anthropic');
      expect(values).toContain('full-anthropic');
      expect(values).toContain('local-plus-anthropic');
      // onSelect dispatches /config apply-preset <value>.
      expect(picker.onSelect.command).toBe('config apply-preset');
    });

    test('/config preset lists saved presets after built-ins', async () => {
      // Seed a saved preset.
      await dispatchConfigCommand('set defaultProvider anthropic', makeCtx());
      const { ctx } = captureCtx();
      await dispatchConfigCommand('save-preset my-snapshot', ctx);
      // Now /config preset should show the saved one too.
      const { ctx: ctx2, cap } = captureCtx();
      await dispatchConfigCommand('preset', ctx2);
      const picker = cap.pickers[0];
      if (!picker) return;
      const values = picker.items.map((i) => i.value);
      expect(values).toContain('my-snapshot');
    });

    test('/config apply-preset <built-in> writes lane values to config', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('apply-preset local-plus-anthropic', ctx);
      expect(result).toContain('applied');
      // Verify the values landed in config.
      const showResult = await dispatchConfigCommand('show', makeCtx());
      expect(showResult).toContain('"cheap-task"');
      expect(showResult).toContain('"ollama"');
      expect(showResult).toContain('qwen2.5:7b');
    });

    test('/config apply-preset emits the refreshed task-routing submenu', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('apply-preset full-anthropic', ctx);
      // Picker re-emit so the user sees the new value columns.
      expect(cap.pickers.length).toBe(1);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('config / task routing');
    });

    test('/config apply-preset <unknown> returns a clear error', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('apply-preset nonexistent', ctx);
      expect(result).toContain('unknown preset');
    });

    test('/config save-preset <name> snapshots current lane config', async () => {
      // First apply a preset to have something to snapshot.
      await dispatchConfigCommand('apply-preset full-anthropic', makeCtx());
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('save-preset my-snapshot', ctx);
      expect(result).toContain('saved');
      // Verify it shows up in /config preset now.
      const { ctx: ctx2, cap } = captureCtx();
      await dispatchConfigCommand('preset', ctx2);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.items.map((i) => i.value)).toContain('my-snapshot');
    });

    test('/config save-preset (no arg) opens inputCard prompting for name', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('save-preset', ctx);
      expect(cap.inputs.length).toBe(1);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.onSubmit.command).toBe('config save-preset');
    });

    test('/config save-preset rejects invalid names', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('save-preset UPPER-CASE', ctx);
      expect(result).toContain('config error');
    });

    test('/config save-preset rejects collision with built-in id', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('save-preset frugal-anthropic', ctx);
      expect(result).toContain('built-in');
    });

    test('/config delete-preset removes a saved preset', async () => {
      // First save one.
      await dispatchConfigCommand('save-preset throwaway', makeCtx());
      // Delete it.
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('delete-preset throwaway', ctx);
      expect(result).toContain('deleted');
      // Verify it's gone.
      const { ctx: ctx2, cap } = captureCtx();
      await dispatchConfigCommand('preset', ctx2);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.items.map((i) => i.value)).not.toContain('throwaway');
    });

    test('/config delete-preset refuses to delete built-in', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('delete-preset frugal-anthropic', ctx);
      expect(result).toContain('cannot delete built-in');
    });

    test('/config delete-preset returns clear error for unknown name', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('delete-preset never-saved', ctx);
      expect(result).toContain('no saved preset');
    });
  });

  // 2026-05-24 patch — draft commit / discard.
  describe('draft commit / discard', () => {
    test('/config (root open) wires onSave on the picker', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onSave?.command).toBe('config commit');
      // 2026-05-24 regression rollback: onCancel is no longer auto-
      // wired to /config discard. Esc reverts to safe close-picker
      // behavior so users don't lose changes by hitting Esc.
      expect(picker.onCancel).toBeUndefined();
    });

    test('sub-pickers also carry onSave (no onCancel)', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('general', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.onSave?.command).toBe('config commit');
      expect(picker.onCancel).toBeUndefined();
    });

    test('/config commit with no draft returns "no changes to save"', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('commit', ctx);
      expect(result).toBe('no changes to save');
    });

    test('/config commit after a set reports the change count', async () => {
      const { ctx } = captureCtx();
      // Open draft via root, then make a change.
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      const result = await dispatchConfigCommand('commit', ctx);
      expect(result).toContain('saved 1 change');
    });

    test('/config commit reports plural correctly', async () => {
      const { ctx } = captureCtx();
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      await dispatchConfigCommand('set maxTurns 50', ctx);
      const result = await dispatchConfigCommand('commit', ctx);
      expect(result).toContain('saved 2 changes');
    });

    test('/config commit fires closeModal so the picker closes on the TUI', async () => {
      // 2026-05-24 patch — the S key dispatches `/config commit` via
      // tea.Sequence after a selection-apply; the commit response
      // must signal closeModal so the parent-refresh picker that the
      // prior dispatch left open actually closes.
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('commit', ctx);
      expect(cap.closeModalCount).toBe(1);
    });

    test('/config discard fires closeModal even with no draft to discard', async () => {
      // 2026-05-24 patch — /config discard is terminal; always closes.
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('discard', ctx);
      expect(cap.closeModalCount).toBe(1);
    });

    test('/config discard with no draft returns "no draft to discard"', async () => {
      const { ctx } = captureCtx();
      const result = await dispatchConfigCommand('discard', ctx);
      expect(result).toBe('no draft to discard');
    });

    test('/config discard with empty draft returns "no changes to discard"', async () => {
      const { ctx } = captureCtx();
      // Open draft (root) but make no changes.
      await dispatchConfigCommand('', ctx);
      const result = await dispatchConfigCommand('discard', ctx);
      expect(result).toBe('no changes to discard');
    });

    test('/config discard restores the baseline + reports the change count', async () => {
      // Seed config with a value first.
      writeFileSync(cfgPath, JSON.stringify({ defaultProvider: 'anthropic' }));
      const { ctx } = captureCtx();
      // Open draft (snapshots {defaultProvider: 'anthropic'}).
      await dispatchConfigCommand('', ctx);
      // Mutate it.
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      // Verify the on-disk value changed.
      const midState = await dispatchConfigCommand('get defaultProvider', makeCtx());
      expect(midState).toContain('ollama');
      // Discard.
      const result = await dispatchConfigCommand('discard', ctx);
      expect(result).toContain('discarded 1 change');
      // Verify the on-disk value is back to the baseline.
      const finalState = await dispatchConfigCommand('get defaultProvider', makeCtx());
      expect(finalState).toContain('anthropic');
      expect(finalState).not.toContain('ollama');
    });

    test('/config discard re-fires live-apply hooks with the baseline value', async () => {
      // Seed config with theme = dark.
      writeFileSync(cfgPath, JSON.stringify({ theme: 'dark' }));
      const { ctx, cap } = captureCtx();
      // Open draft (baseline: theme=dark).
      await dispatchConfigCommand('', ctx);
      // Switch to light — hook records themeChanged: 'light'.
      await dispatchConfigCommand('set theme light', ctx);
      expect(cap.themeChanges).toEqual(['light']);
      // Discard — hook should re-fire with baseline ('dark').
      await dispatchConfigCommand('discard', ctx);
      expect(cap.themeChanges).toEqual(['light', 'dark']);
    });

    test('commit drops the draft so a subsequent open snapshots fresh', async () => {
      writeFileSync(cfgPath, JSON.stringify({ defaultProvider: 'anthropic' }));
      const { ctx } = captureCtx();
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('set defaultProvider ollama', ctx);
      await dispatchConfigCommand('commit', ctx);
      // Now open again — discard should snapshot the NEW state.
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('set defaultProvider openai', ctx);
      await dispatchConfigCommand('discard', ctx);
      const finalState = await dispatchConfigCommand('get defaultProvider', makeCtx());
      // Should be ollama (committed in step 1), not anthropic (the
      // pre-step-1 baseline that's now forgotten).
      expect(finalState).toContain('ollama');
    });

    test('apply-preset records modifications for all touched paths', async () => {
      const { ctx } = captureCtx();
      await dispatchConfigCommand('', ctx);
      await dispatchConfigCommand('apply-preset full-anthropic', ctx);
      const commitResult = await dispatchConfigCommand('commit', ctx);
      // delegator.model + 3 lanes × (provider + model) = 7 changes.
      expect(commitResult).toContain('saved 7 changes');
    });

    test('read-only verbs do NOT open a draft', async () => {
      const { ctx } = captureCtx();
      // path / get / show should not open a draft. Subsequent discard
      // should report "no draft".
      await dispatchConfigCommand('path', ctx);
      await dispatchConfigCommand('show', ctx);
      const result = await dispatchConfigCommand('discard', ctx);
      expect(result).toBe('no draft to discard');
    });
  });

  describe('task-routing submenu integration', () => {
    test('emits the preset shortcut items at the top of the picker', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('task-routing', ctx);
      const picker = cap.pickers[0];
      if (!picker) return;
      const labels = picker.items.map((i) => i.label);
      expect(labels[0]).toBe('Apply preset…');
      expect(labels[1]).toBe('Save current as preset…');
    });

    test('selecting the "Apply preset…" shortcut routes through runEdit to the preset picker', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit __sov_preset_pick__', ctx);
      // Should emit the preset picker, not a field-editor.
      const picker = cap.pickers[0];
      if (!picker) return;
      expect(picker.title).toBe('task-routing presets');
    });

    test('selecting the "Save current as preset…" shortcut opens the name inputCard', async () => {
      const { ctx, cap } = captureCtx();
      await dispatchConfigCommand('edit __sov_preset_save__', ctx);
      expect(cap.inputs.length).toBe(1);
      const input = cap.inputs[0];
      if (!input) return;
      expect(input.title).toBe('save current as preset');
    });
  });
});
