// Slash-command operations for `/config`. Replaces the inline
// handleConfigCommand block that used to live in registry.ts (deleted in
// the 2026-05-24 config UX rebuild — see
// docs/specs/2026-05-24-config-ux-rebuild-design.md).
//
// Verb routing:
//
//   /config                       → root menu picker (10+ groups)
//   /config <group-id>            → group submenu picker (items + values)
//   /config edit <dotpath>        → editor (picker for boolean/enum;
//                                     input for string/number/secret)
//   /config set <dotpath> <value> → validate + persist + fire live-apply
//                                     hook + re-emit parent group picker
//   /config unset <dotpath>       → persist removal + fire live-apply with
//                                     undefined + re-emit parent group picker
//   /config show                  → JSON dump (preserved)
//   /config path                  → print config file path (preserved)
//   /config get <dotpath>         → print value (redacted for secrets)
//
// `/config show`, `/config get`, `/config path` produce plain text output
// only. Everything else emits a `pickerOpen` or `inputOpen` side-effect
// (TUI) when ctx exposes the relevant capability, and falls back to text
// for surfaces that don't (headless dispatch, sov config standalone).
//
// Live-apply: `set` and `unset` look up the dotpath in LIVE_APPLY_HOOKS
// (src/config/liveApply.ts). When a hook exists, the toast says "saved
// — applied to current session"; absent a hook, "saved — effective next
// session". When ctx.commandCtx is undefined (sov config standalone),
// the hook returns 'persisted-only' and the toast says just "saved".

import {
  CONFIG_CATALOG,
  type ConfigEditor,
  type ConfigItem,
  findGroup,
  findGroupForItem,
  findItem,
  getLiveApplyHook,
  listRootMenuGroups,
  listUnmanagedKeys,
} from '../config/catalog.js';
import {
  commitDraft,
  ensureDraft,
  recordModification,
  takeBaselineForDiscard,
} from '../config/draftManager.js';
import type { LiveApplySideEffect } from '../config/liveApply.js';
import {
  BUILTIN_PRESETS,
  type PresetShape,
  applyPresetToSettings,
  findBuiltinPreset,
  readSavedPresets,
  snapshotCurrentAsPreset,
  validatePresetName,
} from '../config/presets.js';
import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from '../config/store.js';
import type { CommandContext, InputOpenConfig, PickerOpenConfig } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Constants — surfaced strings (toast text) live here so tests can assert.
// ──────────────────────────────────────────────────────────────────────

const SECRET_MASK = '••••••••';
const UNSET_DISPLAY = '(unset)';
const TOAST_APPLIED = 'saved — applied to current session';
const TOAST_PERSISTED_ONLY = 'saved — effective next session';
const TOAST_SAVED_NO_SESSION = 'saved';

/**
 * Sentinel "value" strings dispatched by the task-routing submenu's
 * preset shortcut items. `runEdit` checks for these before the normal
 * `findItem(dotpath)` lookup and routes to the preset verbs instead.
 * The `__sov_*__` namespace avoids collision with any real config
 * dotpath. Phase 2.5.
 */
const PRESET_ACTION_PICK_SENTINEL = '__sov_preset_pick__';
const PRESET_ACTION_SAVE_SENTINEL = '__sov_preset_save__';

// ──────────────────────────────────────────────────────────────────────
// Back-navigation — 2026-05-24 patch.
// ──────────────────────────────────────────────────────────────────────

/**
 * Standard key-binding pair carried by every /config picker. The Go
 * TUI wires the S key to `/config commit` (save & exit).
 *
 * 2026-05-24 (regression rollback): the `onCancel` binding that
 * routed Esc to `/config discard` is GONE. v0.5.8 wired it but users
 * hit Esc reflexively and lost changes. /config set writes through to
 * disk immediately; "discard the whole session" wasn't matching the
 * user's mental model. Esc now reverts to the standard close-picker
 * behavior (back-nav when OnBack is set, "(cancelled)" close
 * otherwise). The /config discard slash verb is still available for
 * users who explicitly want to roll back.
 */
function configPickerBindings(): {
  onSave: { command: string };
} {
  return {
    onSave: { command: 'config commit' },
  };
}

/**
 * Resolve the `onBack` command for a picker shown at `groupId`.
 *
 * - Top-level groups (any catalog group not nested under a drill-in
 *   root): backspace re-dispatches `config` → root menu.
 * - Drill-in subgroups (`providers-anthropic`, `providers-openai`, …):
 *   backspace re-dispatches `config providers` → the drill-in root.
 * - The "advanced" virtual group: backspace re-dispatches `config`.
 * - Root menu itself never calls this — it has no parent.
 *
 * Returns the literal back-command string, or undefined when there's
 * no parent.
 */
function parentCommandForGroup(groupId: string): string | undefined {
  if (groupId === 'advanced') return 'config';
  // Walk the catalog: if any group has a drillInto entry whose
  // targetGroupId matches, that group is the parent.
  for (const group of CONFIG_CATALOG) {
    if (group.drillInto === undefined) continue;
    for (const sub of group.drillInto) {
      if (sub.targetGroupId === groupId) return `config ${group.id}`;
    }
  }
  // No drill-in parent → top-level group. Back goes to the root menu.
  return 'config';
}

// ──────────────────────────────────────────────────────────────────────
// Public dispatcher
// ──────────────────────────────────────────────────────────────────────

/**
 * Main entry point. The slash registry routes `/config <args>` here.
 * Returns the textual output to print; side-effects (pickerOpen,
 * inputOpen, verboseChanged, themeChanged) flow through `ctx`'s closure
 * methods.
 */
export async function dispatchConfigCommand(args: string, ctx: CommandContext): Promise<string> {
  const trimmed = args.trim();

  // Legacy `show` shortcut — preserved as a JSON-dump escape hatch.
  if (trimmed === 'show') {
    return showJson();
  }

  // 2026-05-24 patch — open a draft for the current session on every
  // non-read-only /config dispatch. The draft snapshots config so /config
  // discard can roll back. Read-only verbs (path / get / show) don't
  // need a draft. commit / discard themselves manage draft state.
  const firstSpace = trimmed.search(/\s/);
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const readOnlyVerbs = new Set(['path', 'get', 'show', 'commit', 'discard']);
  if (!readOnlyVerbs.has(verb)) {
    ensureDraft(ctx.sessionId, readConfig());
  }

  // No verb: root menu picker.
  if (trimmed === '') {
    return openRootMenu(ctx);
  }

  try {
    if (verb === 'path') return resolveConfigPath();
    if (verb === 'get') return runGet(rest);
    if (verb === 'set') return await runSet(rest, ctx);
    if (verb === 'unset') return await runUnset(rest, ctx);
    if (verb === 'edit') return runEdit(rest, ctx);
    // 2026-05-24 Phase 2.5 — preset verbs.
    if (verb === 'preset') return openPresetPicker(ctx);
    if (verb === 'apply-preset') return await runApplyPreset(rest, ctx);
    if (verb === 'save-preset') return runSavePreset(rest, ctx);
    if (verb === 'delete-preset') return runDeletePreset(rest, ctx);
    // 2026-05-24 patch — draft commit/discard.
    if (verb === 'commit') return runCommit(ctx);
    if (verb === 'discard') return await runDiscard(ctx);

    // Maybe the verb is a group id — drill into that group.
    if (findGroup(verb) !== undefined || verb === 'advanced') {
      return openGroup(verb, ctx);
    }

    return [
      `unknown /config verb: ${verb}`,
      'usage: /config [<group-id>|edit <dotpath>|set <dotpath> <value>|unset <dotpath>|preset|apply-preset <name>|save-preset <name>|delete-preset <name>|commit|discard|show|path|get <dotpath>]',
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `config error: ${msg}`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Root menu — emit a pickerOpen for the 10+ groups.
// ──────────────────────────────────────────────────────────────────────

function openRootMenu(ctx: CommandContext): string {
  const groups = listRootMenuGroups();
  const settings = readConfig();
  const unmanaged = listUnmanagedKeys(settings);

  // Surfaces without requestPicker (headless dispatch): fall back to a
  // plain-text listing so the verb is still useful.
  if (ctx.requestPicker === undefined) {
    const lines: string[] = ['config groups:'];
    for (const group of groups) lines.push(`  ${group.id}  — ${group.label}`);
    if (unmanaged.length > 0) lines.push(`  advanced  — ${unmanaged.length} unmanaged key(s)`);
    lines.push('');
    lines.push('open a group: /config <group-id>   |   edit a field: /config edit <dotpath>');
    return lines.join('\n');
  }

  const picker: PickerOpenConfig = {
    title: 'config',
    subtitle: `${groups.length} group${groups.length === 1 ? '' : 's'}`,
    items: groups.map((group) => ({
      label: group.label,
      value: group.id,
      ...(group.description !== undefined ? { hint: group.description } : {}),
    })),
    initial: 0,
    onSelect: { command: 'config' },
    ...configPickerBindings(),
  };

  if (unmanaged.length > 0) {
    picker.items.push({
      label: 'Advanced (unmanaged)',
      value: 'advanced',
      hint: `${unmanaged.length} top-level key(s) not in the catalog`,
    });
  }

  ctx.requestPicker(picker);
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// Group submenu — emit a pickerOpen for the items in a group.
// ──────────────────────────────────────────────────────────────────────

function openGroup(groupId: string, ctx: CommandContext): string {
  // Special-case: "advanced" is a virtual group rendered from
  // listUnmanagedKeys. It's not in the catalog.
  if (groupId === 'advanced') {
    return openAdvancedGroup(ctx);
  }

  const group = findGroup(groupId);
  if (group === undefined) {
    return `unknown config group: ${groupId}`;
  }

  // Drill-in root (Providers): items list is empty, drillInto carries
  // the subgroup pointers. Selecting a subgroup dispatches `/config <subgroupId>`.
  if (group.drillInto !== undefined && group.drillInto.length > 0) {
    if (ctx.requestPicker === undefined) {
      const lines: string[] = [`${group.label}:`];
      for (const sub of group.drillInto) lines.push(`  ${sub.targetGroupId}  — ${sub.label}`);
      return lines.join('\n');
    }
    const parentCmd = parentCommandForGroup(group.id);
    ctx.requestPicker({
      title: `config / ${group.label.toLowerCase()}`,
      ...(group.description !== undefined ? { subtitle: group.description } : {}),
      items: group.drillInto.map((sub) => ({ label: sub.label, value: sub.targetGroupId })),
      initial: 0,
      onSelect: { command: 'config' },
      ...(parentCmd !== undefined ? { onBack: { command: parentCmd } } : {}),
      ...configPickerBindings(),
    });
    return '';
  }

  const settings = readConfig();
  const redacted = redactSecrets(settings);

  if (ctx.requestPicker === undefined) {
    // Headless fallback: print the items + current values + reload-badge.
    const lines: string[] = [`${group.label}:`];
    for (const item of group.items) {
      const valueDisplay = renderValueColumn(item, redacted, settings);
      const badge = getLiveApplyHook(item.path) !== undefined ? '  [live]' : '  [next-session]';
      lines.push(`  ${item.path}  = ${valueDisplay}${badge}`);
    }
    lines.push('');
    lines.push('edit: /config edit <dotpath>');
    return lines.join('\n');
  }

  const parentCmd = parentCommandForGroup(group.id);
  // 2026-05-24 Phase 2.5 — task-routing submenu gains two preset
  // shortcuts at the top: pick a preset to apply, or save the current
  // lane config as a named preset. Selection dispatches sentinel
  // values that runEdit routes to the preset verbs.
  const items: PickerOpenConfig['items'] =
    group.id === 'task-routing'
      ? [
          {
            label: 'Apply preset…',
            value: PRESET_ACTION_PICK_SENTINEL,
            hint: 'frugal-anthropic / full-anthropic / local-plus-anthropic / saved',
          },
          {
            label: 'Save current as preset…',
            value: PRESET_ACTION_SAVE_SENTINEL,
            hint: 'snapshot delegator + lanes under a name',
          },
          ...group.items.map((item) => buildGroupItemPickerRow(item, redacted, settings)),
        ]
      : group.items.map((item) => buildGroupItemPickerRow(item, redacted, settings));
  ctx.requestPicker({
    title: `config / ${group.label.toLowerCase()}`,
    ...(group.description !== undefined ? { subtitle: group.description } : {}),
    items,
    initial: 0,
    onSelect: { command: 'config edit' },
    ...(parentCmd !== undefined ? { onBack: { command: parentCmd } } : {}),
    ...configPickerBindings(),
  });
  return '';
}

function openAdvancedGroup(ctx: CommandContext): string {
  const settings = readConfig();
  const unmanaged = listUnmanagedKeys(settings);
  const redacted = redactSecrets(settings);

  if (unmanaged.length === 0) {
    return 'no unmanaged config keys.';
  }

  if (ctx.requestPicker === undefined) {
    const lines: string[] = ['advanced (unmanaged) keys:'];
    for (const key of unmanaged) {
      const value = getAt(redacted as Record<string, unknown>, key);
      lines.push(`  ${key}  = ${formatValue(value)}`);
    }
    return lines.join('\n');
  }

  ctx.requestPicker({
    title: 'config / advanced (unmanaged)',
    subtitle: `${unmanaged.length} top-level key${unmanaged.length === 1 ? '' : 's'} not in the catalog`,
    items: unmanaged.map((key) => {
      const value = getAt(redacted as Record<string, unknown>, key);
      return {
        label: key,
        value: key,
        valueColumn: formatValueColumnRaw(value),
      };
    }),
    initial: 0,
    // Selecting an unmanaged key surfaces /config get <key>. Editing
    // unmanaged keys is v0-out-of-scope.
    onSelect: { command: 'config get' },
    onBack: { command: 'config' },
    ...configPickerBindings(),
  });
  return '';
}

function buildGroupItemPickerRow(
  item: ConfigItem,
  redacted: ReturnType<typeof redactSecrets>,
  settings: ReturnType<typeof readConfig>,
): {
  label: string;
  value: string;
  hint?: string;
  valueColumn?: string;
  badge?: 'live' | 'reload';
} {
  const valueColumn = renderValueColumn(item, redacted, settings);
  const liveApply = getLiveApplyHook(item.path) !== undefined;
  const row: {
    label: string;
    value: string;
    hint?: string;
    valueColumn?: string;
    badge?: 'live' | 'reload';
  } = {
    label: item.label,
    value: item.path,
    valueColumn,
    badge: liveApply ? 'live' : 'reload',
  };
  if (item.description !== undefined) row.hint = item.description;
  return row;
}

function renderValueColumn(
  item: ConfigItem,
  redacted: ReturnType<typeof redactSecrets>,
  _settings: ReturnType<typeof readConfig>,
): string {
  const raw = getAt(redacted as Record<string, unknown>, item.path);
  if (item.secret === true) {
    if (raw === undefined || raw === null || raw === '') return UNSET_DISPLAY;
    return SECRET_MASK;
  }
  return formatValueColumnRaw(raw);
}

function formatValueColumnRaw(raw: unknown): string {
  if (raw === undefined) return UNSET_DISPLAY;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw);
}

// ──────────────────────────────────────────────────────────────────────
// Edit — open the appropriate editor (picker or input) for the dotpath.
// ──────────────────────────────────────────────────────────────────────

function runEdit(rest: string, ctx: CommandContext): string {
  if (!rest) return 'usage: /config edit <dotpath>';
  const path = rest;
  // 2026-05-24 Phase 2.5 — task-routing submenu's preset shortcut
  // sentinels route through the dispatcher's `edit` verb. Detect them
  // here and route to the preset handlers instead of the field-editor
  // path. Real catalog paths never start with `__sov_*__`.
  if (path === PRESET_ACTION_PICK_SENTINEL) return openPresetPicker(ctx);
  if (path === PRESET_ACTION_SAVE_SENTINEL) return runSavePreset('', ctx);
  const item = findItem(path);
  if (item === undefined) {
    return `unknown config field: ${path}\nlist available: /config`;
  }

  const settings = readConfig();
  const currentRaw = getAt(settings as Record<string, unknown>, path);
  const editor = item.editor;

  // Boolean / enum / string-with-choices → picker
  if (editor.kind === 'boolean') {
    return openBooleanPicker(item, currentRaw, ctx);
  }
  if (editor.kind === 'enum') {
    return openEnumPicker(item, editor.choices, currentRaw, ctx, false);
  }
  if (editor.kind === 'string') {
    // 2026-05-24 patch — evaluate dynamicChoices against the current
    // settings so e.g. defaultModel's choices reflect the active
    // defaultProvider.
    const dynamic =
      typeof editor.dynamicChoices === 'function' ? editor.dynamicChoices(settings) : undefined;
    const choices = dynamic ?? editor.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      return openEnumPicker(item, choices, currentRaw, ctx, editor.allowCustom === true);
    }
  }

  // String / number / secret → inputOpen
  return openInputEditor(item, editor, currentRaw, ctx);
}

function openBooleanPicker(item: ConfigItem, currentRaw: unknown, ctx: CommandContext): string {
  const choices = ['true', 'false'];
  if (ctx.requestPicker === undefined) {
    return [
      `${item.path}  (boolean)`,
      `current: ${currentRaw === undefined ? UNSET_DISPLAY : String(currentRaw)}`,
      'set: /config set ${path} true|false',
    ].join('\n');
  }
  const initial = currentRaw === true ? 0 : currentRaw === false ? 1 : 0;
  const backCmd = backCommandForEditor(item);
  ctx.requestPicker({
    title: item.path,
    ...(item.description !== undefined ? { subtitle: item.description } : {}),
    items: choices.map((c) => ({ label: c, value: c })),
    initial,
    onSelect: { command: `config set ${item.path}` },
    ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
    ...configPickerBindings(),
  });
  return '';
}

/**
 * Resolve the back-navigation command for an editor opened on `item`.
 * Backspace from the editor returns to the field's containing group.
 *
 * 2026-05-24 patch.
 */
function backCommandForEditor(item: ConfigItem): string | undefined {
  const parent = findGroupForItem(item.path);
  if (parent === undefined) return undefined;
  return `config ${parent.id}`;
}

/**
 * Magic sentinel value for the "↪ type custom value…" picker item.
 * When runSet sees this value for an item whose editor declared
 * `allowCustom: true`, it reroutes to the free-text input editor
 * instead of trying to persist the literal sentinel.
 *
 * The double-underscore + namespace prefix avoids collision with any
 * real config value a user might want to set. 2026-05-24 patch.
 */
const CUSTOM_VALUE_SENTINEL = '__sov_config_type_custom__';

function openEnumPicker(
  item: ConfigItem,
  choices: readonly string[],
  currentRaw: unknown,
  ctx: CommandContext,
  allowCustom: boolean,
): string {
  if (ctx.requestPicker === undefined) {
    return [
      `${item.path}  (enum)`,
      `current: ${currentRaw === undefined ? UNSET_DISPLAY : String(currentRaw)}`,
      `choices: ${choices.join(', ')}`,
      `set: /config set ${item.path} <choice>`,
    ].join('\n');
  }
  const currentStr = typeof currentRaw === 'string' ? currentRaw : '';
  const initial = Math.max(
    0,
    choices.findIndex((c) => c === currentStr),
  );
  const backCmd = backCommandForEditor(item);
  const baseItems = choices.map((c) => ({
    label: c,
    value: c,
    ...(c === currentStr ? { hint: '(current)' } : {}),
  }));
  // 2026-05-24 patch — append the custom-value sentinel when the
  // editor allows free-text input alongside the known choices.
  // Selecting it re-dispatches `config set <path> <CUSTOM_SENTINEL>`,
  // which runSet recognizes and reroutes to the input editor.
  const items = allowCustom
    ? [
        ...baseItems,
        {
          label: '↪ type custom value…',
          value: CUSTOM_VALUE_SENTINEL,
          hint: 'open free-text editor',
        },
      ]
    : baseItems;
  ctx.requestPicker({
    title: item.path,
    ...(item.description !== undefined ? { subtitle: item.description } : {}),
    items,
    initial,
    onSelect: { command: `config set ${item.path}` },
    ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
    ...configPickerBindings(),
  });
  return '';
}

function openInputEditor(
  item: ConfigItem,
  editor: ConfigEditor,
  currentRaw: unknown,
  ctx: CommandContext,
): string {
  // Secrets: never echo current value.
  const isSecret = item.secret === true || editor.kind === 'secret';
  const initial = isSecret
    ? ''
    : currentRaw === undefined || currentRaw === null
      ? ''
      : typeof currentRaw === 'string'
        ? currentRaw
        : JSON.stringify(currentRaw);

  if (ctx.requestInput === undefined) {
    // Headless fallback: surface usage so scripted callers can still set.
    return [
      `${item.path}  (${editor.kind})`,
      isSecret
        ? 'current: (hidden)'
        : `current: ${currentRaw === undefined ? UNSET_DISPLAY : String(currentRaw)}`,
      `set: /config set ${item.path} <value>`,
    ].join('\n');
  }

  const backCmd = backCommandForEditor(item);
  const input: InputOpenConfig = {
    title: item.path,
    ...(item.description !== undefined ? { subtitle: item.description } : {}),
    ...(initial !== '' ? { initial } : {}),
    ...(editor.kind === 'string' && editor.placeholder !== undefined
      ? { placeholder: editor.placeholder }
      : {}),
    ...(editor.kind === 'number' && editor.placeholder !== undefined
      ? { placeholder: editor.placeholder }
      : {}),
    ...(isSecret ? { masked: true } : {}),
    onSubmit: { command: `config set ${item.path}` },
    ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
  };
  ctx.requestInput(input);
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// Set — validate + persist + fire live-apply + re-emit parent group picker.
// ──────────────────────────────────────────────────────────────────────

async function runSet(rest: string, ctx: CommandContext): Promise<string> {
  const split = rest.search(/\s/);
  if (split === -1) return 'usage: /config set <dotpath> <value>';
  const path = rest.slice(0, split);
  const rawValue = rest.slice(split + 1).trim();

  // 2026-05-24 review #5 — coerce by editor kind, NOT by parseValueLiteral.
  // The legacy `parseValueLiteral` over-eagerly turned `"42"` into `42`,
  // which broke string fields like `defaultModel` (zod requires string,
  // user typed a numeric-looking model name → rejected). Look up the
  // catalog item and convert per its editor.kind. Fields not in the
  // catalog fall through to parseValueLiteral for backward-compat with
  // the legacy `/config set <unmanaged-path> <value>` CLI verb.
  const item = findItem(path);

  // 2026-05-24 patch — custom-value sentinel. The "↪ type custom value…"
  // picker item dispatches the magic sentinel as its value; runSet
  // recognizes it and reroutes to the input editor for free-text entry
  // instead of trying to persist the literal sentinel string.
  if (rawValue === CUSTOM_VALUE_SENTINEL && item !== undefined) {
    const settings = readConfig();
    const currentRaw = getAt(settings as Record<string, unknown>, path);
    return openInputEditor(item, item.editor, currentRaw, ctx);
  }

  const value = coerceValueForEditor(rawValue, item);

  // 2026-05-24 review #1 (HIGH) — validate-then-preserve-editor. The
  // current contract closes the InputCard / picker on Enter (Go side)
  // BEFORE the round-trip resolves. If schema validation fails, the
  // user lost their typed value. Fix: on validation failure, re-emit
  // the SAME editor with the user's value preserved + the error as
  // the editor's subtitle, so they can correct in place.
  const before = readConfig();
  let next: ReturnType<typeof setAt>;
  try {
    next = setAt(before, path, value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reopenEditorWithError(item, path, rawValue, message, ctx);
  }
  writeConfig(next);
  // 2026-05-24 patch — track this path in the active draft so
  // /config discard knows what to roll back.
  recordModification(ctx.sessionId, path);

  // 2026-05-24 patch — defaultModel cascade fix. The provider
  // resolver picks providers.<defaultProvider>.model BEFORE falling
  // through to settings.defaultModel (see src/providers/resolver.ts:
  // model ?? providerConfig?.model ?? settings.defaultModel). So a
  // user who changes defaultModel via /config while a
  // providers.<x>.model override is set sees no effect on the next
  // session — the override shadows their edit. When the user is
  // changing defaultModel, infer their intent ("THIS model, please")
  // by also clearing the provider override so the cascade resolves
  // to the new defaultModel. Toast surfaces what we cleared so the
  // change isn't silent.
  let cascadeNote = '';
  if (path === 'defaultModel') {
    const afterSet = readConfig();
    const activeProvider = afterSet.defaultProvider ?? 'anthropic';
    const overridePath = `providers.${activeProvider}.model`;
    const providerModel = getAt(afterSet as Record<string, unknown>, overridePath);
    if (providerModel !== undefined && providerModel !== null) {
      const cleared = unsetAt(afterSet, overridePath);
      writeConfig(cleared);
      recordModification(ctx.sessionId, overridePath);
      cascadeNote = ` (also cleared ${overridePath} = ${String(providerModel)} so the new default takes effect)`;
    }
  }

  // Fire live-apply hook, if any.
  const standalone = ctx.isConfigStandalone === true;
  const sideEffect: LiveApplySideEffect = {};
  let recordedSideEffect = false;
  const hook = getLiveApplyHook(path);
  const verdict = hook
    ? await hook(value, {
        // In `sov config` standalone mode the hook receives undefined
        // for commandCtx, matching the spec's contract.
        ...(standalone ? {} : { commandCtx: ctx }),
        recordSideEffect: (effect) => {
          recordedSideEffect = true;
          Object.assign(sideEffect, effect);
        },
      })
    : 'persisted-only';

  // Relay side-effects through the CommandContext closures.
  if (recordedSideEffect) {
    if (sideEffect.themeChanged !== undefined && ctx.recordThemeChange !== undefined) {
      ctx.recordThemeChange(sideEffect.themeChanged);
    }
    if (sideEffect.verboseChanged !== undefined && ctx.recordVerboseChange !== undefined) {
      ctx.recordVerboseChange(sideEffect.verboseChanged);
    }
  }

  const toast = pickToast(verdict, hook !== undefined, standalone) + cascadeNote;
  return emitParentRefresh(path, toast, ctx);
}

// ──────────────────────────────────────────────────────────────────────
// Unset — persist removal + fire live-apply with undefined + re-emit parent.
// ──────────────────────────────────────────────────────────────────────

async function runUnset(rest: string, ctx: CommandContext): Promise<string> {
  if (!rest) return 'usage: /config unset <dotpath>';
  const path = rest;
  const before = readConfig();
  const next = unsetAt(before, path);
  writeConfig(next);
  recordModification(ctx.sessionId, path);

  const standalone = ctx.isConfigStandalone === true;
  const sideEffect: LiveApplySideEffect = {};
  let recordedSideEffect = false;
  const hook = getLiveApplyHook(path);
  const verdict = hook
    ? await hook(undefined, {
        ...(standalone ? {} : { commandCtx: ctx }),
        recordSideEffect: (effect) => {
          recordedSideEffect = true;
          Object.assign(sideEffect, effect);
        },
      })
    : 'persisted-only';

  if (recordedSideEffect) {
    if (sideEffect.themeChanged !== undefined && ctx.recordThemeChange !== undefined) {
      ctx.recordThemeChange(sideEffect.themeChanged);
    }
    if (sideEffect.verboseChanged !== undefined && ctx.recordVerboseChange !== undefined) {
      ctx.recordVerboseChange(sideEffect.verboseChanged);
    }
  }

  const toast = pickToast(verdict, hook !== undefined, standalone);
  return emitParentRefresh(path, `${toast} (unset ${path})`, ctx);
}

/**
 * Re-emit the parent group's picker so the TUI navigates back to it
 * after a successful set/unset, with refreshed value columns. Returns
 * the toast text so the caller prints it as the slash output (TUI
 * surfaces it as a tea.Println line over the picker).
 */
function emitParentRefresh(path: string, toast: string, ctx: CommandContext): string {
  if (ctx.requestPicker === undefined) {
    // Surfaces without a picker: just print the toast + path.
    return `${toast}\nset ${path}`;
  }
  const parent = findGroupForItem(path);
  if (parent === undefined) {
    return toast;
  }
  // Re-emit the parent group's picker. openGroup will fill items + values.
  openGroup(parent.id, ctx);
  return toast;
}

/**
 * Coerce the user's typed string into the type expected by the field's
 * editor. The legacy `parseValueLiteral` did a one-size-fits-all
 * literal-parse that broke string fields like `defaultModel` (typing
 * `42` becomes the number 42, which the string-only zod schema rejects).
 *
 * - `string`/`secret`/`enum` → return rawValue unchanged
 * - `boolean` → 'true'/'false' (case-insensitive) → bool; else
 *               fall through to parseValueLiteral so the schema can
 *               complain with a clear message
 * - `number` → Number(rawValue) when finite, else NaN (the schema
 *              will reject the NaN with a clear "expected number")
 * - unknown / no catalog item → parseValueLiteral (back-compat for
 *   `/config set <unmanaged-path> <value>` on the CLI)
 *
 * 2026-05-24 review #5.
 */
function coerceValueForEditor(rawValue: string, item: ConfigItem | undefined): unknown {
  if (item === undefined) return parseValueLiteral(rawValue);
  const kind = item.editor.kind;
  if (kind === 'string' || kind === 'secret' || kind === 'enum') return rawValue;
  if (kind === 'boolean') {
    const lower = rawValue.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return parseValueLiteral(rawValue);
  }
  if (kind === 'number') {
    const n = Number(rawValue);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  // Unknown editor kind (future-proof) — fall through.
  return parseValueLiteral(rawValue);
}

/**
 * On validation failure inside `runSet`, re-emit the SAME editor with
 * the user's typed value preserved and the schema error surfaced as
 * the editor's subtitle. Mirrors what `runEdit` does for the initial
 * open; the difference is we pre-populate `initial` with `rawValue`
 * (the literal text the user typed, not the canonical persisted
 * value) so they can correct in place without retyping.
 *
 * Returns the error toast text so the slash output still surfaces
 * "config error: …" in scrollback. The re-emitted editor lands as
 * the active modal alongside that line.
 *
 * 2026-05-24 review #1 (HIGH).
 */
function reopenEditorWithError(
  item: ConfigItem | undefined,
  path: string,
  rawValue: string,
  errorMessage: string,
  ctx: CommandContext,
): string {
  const error = `config error: ${errorMessage}`;
  if (item === undefined) return error;
  const editor = item.editor;
  const subtitle = `Validation failed — ${errorMessage}`;
  const backCmd = backCommandForEditor(item);
  if (editor.kind === 'boolean') {
    if (ctx.requestPicker === undefined) return error;
    ctx.requestPicker({
      title: item.path,
      subtitle,
      items: [
        { label: 'true', value: 'true', ...(rawValue === 'true' ? { hint: '(you typed)' } : {}) },
        {
          label: 'false',
          value: 'false',
          ...(rawValue === 'false' ? { hint: '(you typed)' } : {}),
        },
      ],
      initial: rawValue === 'true' ? 0 : 1,
      onSelect: { command: `config set ${path}` },
      ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
      ...configPickerBindings(),
    });
    return error;
  }
  if (editor.kind === 'enum') {
    if (ctx.requestPicker === undefined) return error;
    ctx.requestPicker({
      title: item.path,
      subtitle,
      items: editor.choices.map((c) => ({
        label: c,
        value: c,
        ...(c === rawValue ? { hint: '(you typed — rejected)' } : {}),
      })),
      initial: 0,
      onSelect: { command: `config set ${path}` },
      ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
      ...configPickerBindings(),
    });
    return error;
  }
  // string / number / secret → re-emit InputCard with the typed value
  // pre-populated. Secrets never echo the value back (the masked input
  // starts empty).
  if (ctx.requestInput === undefined) return error;
  const isSecret = item.secret === true || editor.kind === 'secret';
  const input: InputOpenConfig = {
    title: item.path,
    subtitle,
    ...(isSecret ? {} : { initial: rawValue }),
    ...(isSecret ? { masked: true } : {}),
    onSubmit: { command: `config set ${path}` },
    ...(backCmd !== undefined ? { onBack: { command: backCmd } } : {}),
  };
  ctx.requestInput(input);
  return error;
}

function pickToast(
  verdict: 'applied' | 'persisted-only',
  hookPresent: boolean,
  standalone: boolean,
): string {
  // In `sov config` standalone mode there's no active session — every
  // edit is effectively persisted-only and we collapse the toast to
  // plain "saved" so we don't misleadingly imply "applied to current
  // session". Per spec §"Reload semantics + badge protocol".
  if (standalone) return TOAST_SAVED_NO_SESSION;
  if (!hookPresent) {
    // No hook = field is reload-needed; surface "next session".
    return TOAST_PERSISTED_ONLY;
  }
  if (verdict === 'applied') return TOAST_APPLIED;
  // Hook present but reported persisted-only — typically a conditional
  // hook (provider model didn't match the active provider). Honest
  // outcome is "effective next session".
  return TOAST_PERSISTED_ONLY;
}

// ──────────────────────────────────────────────────────────────────────
// Preset verbs (Phase 2.5, 2026-05-24)
// ──────────────────────────────────────────────────────────────────────

/**
 * `/config preset` — opens a picker of all available presets (built-in
 * + user-saved). Selecting one re-dispatches `/config apply-preset
 * <id>` which writes the preset's values into config.
 */
function openPresetPicker(ctx: CommandContext): string {
  const settings = readConfig();
  const saved = readSavedPresets(settings);
  const savedEntries = Object.entries(saved);

  if (ctx.requestPicker === undefined) {
    // Headless / scriptable surface: text listing.
    const lines: string[] = ['task-routing presets:'];
    for (const p of BUILTIN_PRESETS) {
      lines.push(`  ${p.id}  — ${p.description}  (built-in)`);
    }
    for (const [name, _shape] of savedEntries) {
      lines.push(`  ${name}  — (saved)`);
    }
    lines.push('');
    lines.push('apply: /config apply-preset <id>');
    return lines.join('\n');
  }

  const items: PickerOpenConfig['items'] = [];
  for (const p of BUILTIN_PRESETS) {
    items.push({
      label: p.label,
      value: p.id,
      hint: `${p.description}  (built-in)`,
    });
  }
  for (const [name, _shape] of savedEntries) {
    items.push({
      label: name,
      value: name,
      hint: '(saved)',
    });
  }
  if (items.length === 0) {
    // No saved presets, no built-ins available — defensive fallback.
    return 'no presets available';
  }

  ctx.requestPicker({
    title: 'task-routing presets',
    subtitle: 'select one to apply its values to taskRouting.{delegator,lanes}',
    items,
    initial: 0,
    onSelect: { command: 'config apply-preset' },
    onBack: { command: 'config task-routing' },
    ...configPickerBindings(),
  });
  return '';
}

/**
 * `/config apply-preset <id>` — writes the preset's values into config
 * and triggers a runtime refresh so subsequent turns pick up the new
 * lane settings. Re-emits the task-routing submenu so the user sees
 * the refreshed value columns immediately.
 */
async function runApplyPreset(rest: string, ctx: CommandContext): Promise<string> {
  if (!rest) return 'usage: /config apply-preset <name>';
  const name = rest.trim();
  const builtin = findBuiltinPreset(name);
  const settings = readConfig();
  const saved = readSavedPresets(settings);
  const shape: PresetShape | undefined = builtin?.shape ?? saved[name];
  if (shape === undefined) {
    return `unknown preset: ${name}\nlist: /config preset`;
  }
  const next = applyPresetToSettings(settings, shape);
  writeConfig(next);
  // 2026-05-24 patch — record every path the preset writes so /config
  // discard rolls them back. Preset touches delegator.model + each
  // lane's provider + model.
  recordModification(ctx.sessionId, 'taskRouting.delegator.model');
  for (const lane of ['cheap-task', 'moderate-task', 'frontier-task'] as const) {
    recordModification(ctx.sessionId, `taskRouting.lanes.${lane}.provider`);
    recordModification(ctx.sessionId, `taskRouting.lanes.${lane}.model`);
  }
  // 2026-05-24 taskRouting hot-reload — trigger a runtime rebuild so
  // the lane registry + smart-router prompt segment pick up the
  // preset values immediately. Without this, the user would have to
  // restart for the preset to take effect.
  let liveApplied = false;
  if (ctx.rebuildTaskRouting !== undefined) {
    await ctx.rebuildTaskRouting();
    liveApplied = true;
  }
  const toast = builtin
    ? `preset '${builtin.label}' applied${liveApplied ? ' to current session' : ' — effective next session'}`
    : `saved preset '${name}' applied${liveApplied ? ' to current session' : ' — effective next session'}`;
  // Emit a refreshed task-routing submenu so the user sees the new
  // value columns. (openGroup re-reads settings.)
  if (ctx.requestPicker !== undefined) {
    openGroup('task-routing', ctx);
  }
  return toast;
}

/**
 * `/config save-preset <name>` — snapshots the current taskRouting
 * lane configuration as a named preset under taskRouting.savedPresets.
 * When invoked with no arg, opens an inputCard prompting for a name.
 */
function runSavePreset(rest: string, ctx: CommandContext): string {
  const trimmed = rest.trim();
  if (!trimmed) {
    if (ctx.requestInput === undefined) {
      return 'usage: /config save-preset <name>';
    }
    ctx.requestInput({
      title: 'save current as preset',
      subtitle: 'name: lowercase letters/digits/hyphens/underscores. Snapshots delegator + lanes.',
      placeholder: 'e.g. my-setup',
      onSubmit: { command: 'config save-preset' },
      onBack: { command: 'config task-routing' },
    });
    return '';
  }
  const validation = validatePresetName(trimmed);
  if (validation !== null) {
    return `config error: ${validation}`;
  }
  const settings = readConfig();
  const shape = snapshotCurrentAsPreset(settings);
  // Merge into savedPresets via setAt so the existing immutable-update
  // helpers in store.ts handle the nested path.
  const next = setAt(settings, `taskRouting.savedPresets.${trimmed}`, shape);
  writeConfig(next);
  recordModification(ctx.sessionId, `taskRouting.savedPresets.${trimmed}`);
  // Re-emit the task-routing submenu so the user can immediately
  // verify the snapshot landed.
  if (ctx.requestPicker !== undefined) {
    openGroup('task-routing', ctx);
  }
  return `saved preset '${trimmed}' from current lane configuration`;
}

/**
 * `/config delete-preset <name>` — removes a user-saved preset. Refuses
 * to delete built-in preset ids (they're shipped in code anyway).
 */
function runDeletePreset(rest: string, ctx: CommandContext): string {
  const name = rest.trim();
  if (!name) return 'usage: /config delete-preset <name>';
  if (findBuiltinPreset(name) !== undefined) {
    return `cannot delete built-in preset '${name}'`;
  }
  const settings = readConfig();
  const saved = readSavedPresets(settings);
  if (!Object.hasOwn(saved, name)) {
    return `no saved preset named '${name}'`;
  }
  const next = unsetAt(settings, `taskRouting.savedPresets.${name}`);
  writeConfig(next);
  recordModification(ctx.sessionId, `taskRouting.savedPresets.${name}`);
  if (ctx.requestPicker !== undefined) {
    openGroup('task-routing', ctx);
  }
  return `deleted saved preset '${name}'`;
}

// ──────────────────────────────────────────────────────────────────────
// Draft commit / discard (2026-05-24 patch)
// ──────────────────────────────────────────────────────────────────────

/**
 * `/config commit` — finalize the draft session. The on-disk config is
 * already the latest (each /config set wrote through immediately); we
 * just drop the draft state and surface a "saved N changes" toast.
 *
 * Sent by the Go TUI on the `S` key (every /config picker carries an
 * `onSave: { command: 'config commit' }` binding).
 */
function runCommit(ctx: CommandContext): string {
  const count = commitDraft(ctx.sessionId);
  // 2026-05-24 patch — close any open picker / input card on commit.
  // Critical for the S-as-apply-then-save flow: the prior dispatch
  // in the tea.Sequence chain (the field-apply) re-emits the parent
  // group's picker, and without closeModal we'd leave it open after
  // commit instead of exiting cleanly.
  ctx.requestCloseModal?.();
  if (count === 0) return 'no changes to save';
  return `saved ${count} change${count === 1 ? '' : 's'}`;
}

/**
 * `/config discard` — restore the snapshot taken when the draft
 * opened, re-fire live-apply hooks for each modified path with the
 * baseline value so runtime state reverts in lock-step, and drop the
 * draft. When no draft is active (e.g., the user discarded twice or
 * dispatched /config discard directly without a prior /config), the
 * verb is a no-op with a friendly message.
 *
 * Sent by the Go TUI on `Esc` (every /config picker carries an
 * `onCancel: { command: 'config discard' }` binding).
 */
async function runDiscard(ctx: CommandContext): Promise<string> {
  // 2026-05-24 patch — close modal whether or not there's a draft to
  // discard. /config discard is a terminal verb: the user wants out
  // of the picker chain regardless.
  ctx.requestCloseModal?.();
  const taken = takeBaselineForDiscard(ctx.sessionId);
  if (taken === undefined) return 'no draft to discard';
  if (taken.modifiedPaths.length === 0) {
    // Empty draft — no on-disk changes happened; nothing to roll back.
    return 'no changes to discard';
  }
  // Restore the baseline to disk in one write. The pre-modification
  // settings overwrite whatever's there.
  writeConfig(taken.baseline);
  // Re-fire live-apply hooks for each modified path with the value
  // from the baseline, so runtime state reverts to its pre-draft
  // shape. Hook side-effects (themeChanged / verboseChanged) flow
  // back through ctx so the TUI sees them.
  const sideEffect: LiveApplySideEffect = {};
  let recordedSideEffect = false;
  for (const path of taken.modifiedPaths) {
    const hook = getLiveApplyHook(path);
    if (hook === undefined) continue;
    const baselineValue = getAt(taken.baseline as Record<string, unknown>, path);
    await hook(baselineValue, {
      commandCtx: ctx,
      recordSideEffect: (effect) => {
        recordedSideEffect = true;
        Object.assign(sideEffect, effect);
      },
    });
  }
  if (recordedSideEffect) {
    if (sideEffect.themeChanged !== undefined && ctx.recordThemeChange !== undefined) {
      ctx.recordThemeChange(sideEffect.themeChanged);
    }
    if (sideEffect.verboseChanged !== undefined && ctx.recordVerboseChange !== undefined) {
      ctx.recordVerboseChange(sideEffect.verboseChanged);
    }
  }
  const n = taken.modifiedPaths.length;
  return `discarded ${n} change${n === 1 ? '' : 's'} — restored previous values`;
}

// ──────────────────────────────────────────────────────────────────────
// Legacy verbs: show / get
// ──────────────────────────────────────────────────────────────────────

function showJson(): string {
  const settings = readConfig();
  return JSON.stringify(redactSecrets(settings), null, 2);
}

function runGet(rest: string): string {
  if (!rest) return 'usage: /config get <dotpath>';
  const settings = readConfig();
  const value = getAt(redactSecrets(settings), rest);
  return formatValue(value);
}

// ──────────────────────────────────────────────────────────────────────
// Test seam — internal helpers exposed for unit testing.
// ──────────────────────────────────────────────────────────────────────

export const __test__ = Object.freeze({
  SECRET_MASK,
  UNSET_DISPLAY,
  TOAST_APPLIED,
  TOAST_PERSISTED_ONLY,
  TOAST_SAVED_NO_SESSION,
  renderValueColumn,
  buildGroupItemPickerRow,
  catalog: CONFIG_CATALOG,
  pickToast,
});
