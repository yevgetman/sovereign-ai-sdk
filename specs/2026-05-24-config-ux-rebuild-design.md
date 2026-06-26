# Config UX rebuild — design spec

**Date:** 2026-05-24
**Status:** approved (in-session autonomous authorization 2026-05-24)
**Author:** Claude (autonomous session)

## Goal

Replace the hand-rolled raw-mode `sov config` picker and the JSON-dump `/config` slash command with a single branded TUI experience that:

1. Uses the same Bubble Tea components and visual conventions as the rest of `sov`.
2. Covers every field in `SettingsSchema` (closes the "missing params" gap surfaced in the user's `config1.png` / `config2.png` annotations).
3. Supports hierarchical drill-in navigation across logical groups.
4. Live-applies edits where the runtime has a hook for it; clearly signals when a change won't take effect until next session.
5. Works identically from `sov config` (standalone subcommand) and `/config` (in-session slash command).

## Non-goals

- **Aggressive live-apply.** Wiring new live-apply hooks for fields baked into subsystems (`taskRouting.*`, `permissionMode`, `review.*`, provider rebind on `apiKey` change) is explicitly out of v0. v0 covers the trivial set; future passes can extend.
- **Hot-reload of the runtime.** No rebuilding lane registry, swapping system prompts, or reconstructing managers.
- **Project-level / workspace-level config.** v0 operates only on `~/.harness/config.json` (the user-level config). Permission rules in `.harness/settings.local.json` keep their existing surface.
- **Schema-derived UI.** v0 uses a hand-curated catalog. Future passes may add a "show unmanaged keys" fallback if the catalog falls behind, but the primary path is curated.

## Surfaces

Two entry points, one shared UI:

- **`sov config`** — boots `sov` in `--config-only` mode. No bundle load, no provider preflight, no agent runtime. Hono server is constructed with just the routes the config UI needs; TUI launches with the equivalent of `/config` as its initial command. Exit (Esc from the root menu or `q`) shuts down both processes.
- **`/config`** — slash command inside an active session. Uses the same catalog, same components, same re-dispatch chain.

Both share `src/config/catalog.ts` as the single source of truth.

## Architecture overview

```
                              ~/.harness/config.json
                                       ▲
                                       │ writeConfig / readConfig
                                       │
   src/config/catalog.ts ──────► src/commands/configOps.ts (slash handler)
   (groups + items +                    │
    live-apply hooks)                   │ via slash dispatcher
                                        ▼
                            src/server/routes/commands.ts
                                        │
                                        │ pickerOpen / inputOpen side-effects
                                        ▼
                        Go TUI: PickerCard / InputCard / app.go
                                        │
                                        │ selection → re-dispatch
                                        ▼
                              POST /sessions/:id/dispatch (/config ...)
```

The dispatcher is the pivot: every menu hop, every value edit is a fresh `/config ...` round-trip. No client-side tree state. This matches the M11.5 pattern (ADR M11.5-01..03) and keeps the design uniform with `/model`, `/resume`, `/export`, `/theme`.

## Catalog data model

`src/config/catalog.ts`:

```typescript
import type { Settings } from './schema.js';

export type ConfigEditor =
  | { kind: 'boolean' }
  | { kind: 'enum'; choices: readonly string[] }
  | { kind: 'string'; placeholder?: string; choices?: readonly string[] }
  | { kind: 'number'; min?: number; max?: number; placeholder?: string }
  | { kind: 'secret' };

/**
 * Called after a successful persist when the runtime exposes a hook for
 * applying the change to the active session. Absence of `liveApply`
 * means the field is reload-needed.
 *
 * Return shape distinguishes "applied" (badge becomes ✓ live, toast
 * confirms) from "persisted only" (badge stays ⟳ next session, toast
 * confirms). Errors thrown bubble up to the slash response.
 */
export type LiveApplyHook = (
  newValue: unknown,
  ctx: LiveApplyContext,
) => Promise<'applied' | 'persisted-only'>;

export type LiveApplyContext = {
  /** Active session's CommandContext, when in-session. Undefined in
   *  `sov config` mode — every hook MUST handle the undefined case by
   *  returning 'persisted-only'. */
  commandCtx?: import('../commands/types.js').CommandContext;
  /** Server-side runtime singleton accessor when in-session. Undefined
   *  in `sov config` mode. */
  runtime?: import('../server/runtime.js').Runtime;
};

export type ConfigItem = {
  /** Dotpath into Settings. The single key the catalog uses to map back
   *  to schema validation + readConfig/writeConfig. */
  path: string;
  /** Short label shown in the submenu's row. */
  label: string;
  /** One-line context shown under the row when selected and on the
   *  edit screen. */
  description?: string;
  editor: ConfigEditor;
  /** When true, value display is masked in lists and the editor uses
   *  EchoMode.Password. */
  secret?: boolean;
  /** When present, called after persist. Absence = "⟳ next session". */
  liveApply?: LiveApplyHook;
};

export type ConfigGroup = {
  id: string;        // 'general' | 'providers' | 'task-routing' | ...
  label: string;     // 'General' | 'Providers' | 'Task routing' | ...
  description?: string;
  items: ConfigItem[];
};

export const CONFIG_CATALOG: readonly ConfigGroup[] = [/* see appendix */];

export function findGroup(id: string): ConfigGroup | undefined;
export function findItem(path: string): ConfigItem | undefined;
```

Validation on write goes through the existing `SettingsSchema.parse(...)` after `setAt`. Catalog editor types are advisory only — schema is authoritative.

## v0 catalog coverage

10 groups covering every field in `SettingsSchema`:

| Group ID | Label | Fields |
|---|---|---|
| `general` | General | `defaultProvider`, `defaultModel`, `permissionMode`, `maxTurns`, `verbose` |
| `providers` | Providers | Drill into per-provider sub-pages: `anthropic`, `openai`, `openrouter`, `ollama` |
| `task-routing` | Task routing | `taskRouting.enabled`, `taskRouting.delegator.model`, per-lane `provider` / `model` / `timeoutMs` for `cheap-task` / `moderate-task` / `frontier-task` |
| `router` | Router (local-first) | `router.defaultLane`, `router.localProvider`, `router.localModel`, `router.frontierProvider`, `router.frontierModel`, `router.escalationMode`, `router.maxConcurrentLocal`, `router.maxConcurrentFrontier` |
| `compaction` | Compaction | `microcompaction.enabled`, `microcompaction.keepRecent`, `microcompaction.triggerThresholdPct`, `compaction.proactiveThresholdPct` |
| `web-search` | Web search | `webSearch.provider`, `webSearch.apiKey`, `webSearch.maxResults` |
| `review` | Review | `review.autoPromoteMemory`, `review.autoPromoteSkills`, `review.userTurnsForMemoryReview`, `review.toolIterationsForSkillReview`, `review.childReviewEveryN`, `review.minIntervalMs`, `review.disabled` |
| `learning` | Learning | `learning.disabled`, `learning.synthesizerEveryN`, `learning.synthesizerEveryNToolIterations`, `learning.observationBufferSize`, `learning.pruneBelowConfidence`, `learning.pruneAgeDays`, plus the 4 tunables (`reinforcementCurveK`, `contradictionDelta`, `confidenceCap`, `initialConfidenceBaseline`), `learning.crossProjectMinConfidence` |
| `debug` | Debug | `debugMode.enabled`, `debugMode.transcript`, `debugMode.transcriptDir`, `debugMode.transcriptRedactPct` |
| `openai-server` | OpenAI server | `openaiServer.apiKey`, `openaiServer.port`, `openaiServer.host` |
| `appearance` | Appearance | `theme` |

`behavior.*` and `ui.*` fields fold into Appearance + General as appropriate.

## v0 live-apply set

Six fields with hooks. Everything else is `⟳ next session`.

| Path | Hook behavior |
|---|---|
| `theme` | Calls `applyTheme(value)` (TS-side singleton update) + sets `themeChanged` side-effect — same protocol `/theme` uses today. |
| `defaultModel` | Calls `ctx.setModel(value)` when invoked from `/config`; no-op in `sov config` mode. |
| `providers.<currentProviderName>.model` | When `<currentProviderName>` matches the active session's provider, calls `ctx.setModel(value)`. Otherwise persisted-only. |
| `maxTurns` | Verified read-on-demand in the turn loop; the persisted value is picked up automatically. Hook just confirms applied. |
| `verbose` | Sets `verboseChanged` side-effect (new) so the TUI updates render mode. *Verification required:* if a re-render isn't enough and verbose is baked at boot, downgrade to `⟳ next session`. |
| `webSearch.*` | Verified read-on-demand in `WebSearchTool` invoke path; hook confirms applied. |

Each hook MUST handle `LiveApplyContext.commandCtx === undefined` by returning `'persisted-only'` (the `sov config` standalone case).

## Wire protocol

### Extended `PickerOpenItem` schema

Adds two optional fields to existing `PickerOpenItemSchema`:

```typescript
const PickerOpenItemSchema = z.object({
  label: z.string(),
  value: z.string(),
  hint: z.string().optional(),
  // NEW:
  valueColumn: z.string().optional(),  // right-aligned current value display
  badge: z.enum(['live', 'reload']).optional(),  // ✓ live | ⟳ next session
});
```

Backward-compatible — `/model`, `/resume`, `/export`, `/theme` keep working without modification.

### New `inputOpen` side-effect

Parallel to `pickerOpen`. Triggered for editor kinds `string` / `number` / `secret`.

```typescript
const InputOpenConfigSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  initial: z.string().optional(),
  placeholder: z.string().optional(),
  masked: z.boolean().optional(),
  /** Slash command to re-dispatch with the typed value as args. */
  onSubmit: z.object({ command: z.string() }),
});

// In CommandResponseSideEffectsSchema:
// pickerOpen: PickerOpenConfigSchema.optional()
// themeChanged: z.string().optional()
// inputOpen: InputOpenConfigSchema.optional()  // NEW
// verboseChanged: z.boolean().optional()       // NEW (for verbose live-apply)
```

### `/config` slash command shape

```
/config                       → opens root menu picker (groups)
/config <group-id>            → opens that group's submenu picker
/config edit <dotpath>        → opens the appropriate editor (picker or input)
/config set <dotpath> <value> → persists + fires live-apply hook
/config unset <dotpath>       → removes + fires live-apply hook with undefined
/config show                  → JSON dump (preserved for scripting)
/config path                  → prints config file path
/config get <dotpath>         → prints value (redacted for secrets)
```

The first three are new. The last four are preserved for backwards compatibility with the existing CLI verbs and any scripts that depend on them.

### Re-dispatch flow (one full edit)

```
User opens root: /config
  ← pickerOpen { title: "config", items: [10 groups...], onSelect: { command: "config" } }
User selects "Task routing"
  ← (TUI sends) /config task-routing
  ← pickerOpen { title: "config / task routing", items: [items with valueColumn+badge], onSelect: { command: "config edit" } }
User selects "enabled"
  ← (TUI sends) /config edit taskRouting.enabled
  ← pickerOpen { title: "taskRouting.enabled", items: [{label:"false",...},{label:"true",...}], onSelect: { command: "config set taskRouting.enabled" } }
User picks "true"
  ← (TUI sends) /config set taskRouting.enabled true
  ← (response) "saved — effective next session"
  ← pickerOpen { ...task routing submenu, refreshed with new value } (returned alongside the status text via a new "afterCommit" pattern)
```

The "return to parent menu after commit" is achieved by having `/config set <path> <value>` emit BOTH a status string AND a `pickerOpen` for the parent group. The TUI shows the status as a toast over the picker. Existing `pickerOpen` rendering supports this with no changes — it just opens the picker; toast is a separate text-print.

## Component changes

### Go TUI: `PickerCard` extension

`packages/tui/internal/components/pickercard.go`:

- Add optional `ValueColumn` + `Badge` fields to `PickerItem`.
- View renders value column right-aligned (3-space gap from label).
- Badge renders after value: `✓ live` in success-green, `⟳ next session` in dim-orange.
- When neither is set, layout is unchanged (preserves `/model` / `/resume` / `/export` / `/theme` look).

### Go TUI: new `InputCard`

`packages/tui/internal/components/inputcard.go`:

- Bubble Tea component using `bubbles/textinput`.
- Constructor takes `transport.InputOpenPayload` + theme.
- Renders title (bold) + optional subtitle (dim italic) + text input + footer hint (`enter submit · esc cancel`).
- `EchoMode = textinput.EchoPassword` when `masked` is true; falls back to `EchoNormal` otherwise.
- `Value()` returns the typed string.
- `Command()` returns the re-dispatch command from `OnSubmit.Command`.
- Same `CardBorderStyle` box as PickerCard for visual consistency.

### Go TUI: `app.go` integration

- Add `inputCard *InputCard` field to model (parallel to `pickerCard`).
- SSE event handler: on `inputOpen` side-effect, construct InputCard, set as active modal, route key events.
- On Enter: dispatch `<onSubmit.command> <value>`, clear modal.
- On Esc: clear modal.
- `verboseChanged` side-effect: update `m.verbose` field, recompute toolcard render mode.

### TS: catalog + slash dispatcher

- `src/config/catalog.ts` — new file. ~400 LoC.
- `src/config/liveApply.ts` — new file with the 6 v0 hooks. ~150 LoC.
- `src/commands/configOps.ts` — extracted from `registry.ts`'s inline `handleConfigCommand`. Hosts the new verbs (`edit`, the no-args picker, the `<group-id>` picker, plus the legacy `show`/`path`/`get`/`set`/`unset`). `set` and `unset` route through the catalog's live-apply hook when one is registered.
- `src/commands/registry.ts` — `/config` entry now delegates entirely to `configOps`. The whole `handleConfigCommand` block goes away (replaced).

### TS: `sov config` standalone mode

- `src/main.ts` — `sov config` action changes from `runConfigMenu` to a new `runConfigOnlyMode` in `src/cli/configMode.ts`.
- `src/cli/configMode.ts` — new file. Constructs a minimal Hono server (no `buildRuntime`, no preflight, no agent runtime). Mounts only:
  - The slash-command dispatcher route (`POST /sessions/:id/dispatch`)
  - The commands metadata route (`GET /sessions/:id/commands`)
  - The session creation route (so the TUI's normal boot path works)
  - The SSE event stream (for side-effect delivery)
- Launches `sov-tui` with `--initial-command=/config` (new CLI flag on the TUI side that fires that slash command immediately after boot).
- On TUI exit, server stops and process exits 0.

### TS: deletions

- `src/ui/configMenu.ts` — deleted entirely. ~390 LoC removed.
- The `runConfigMenu` import in `src/main.ts` — removed.
- All references in tests — updated to use the new catalog path.

## Reload semantics + badge protocol

- **`✓ live`** — green checkmark + word "live". The catalog item has a `liveApply` hook. Edit takes effect immediately.
- **`⟳ next session`** — dim-orange refresh glyph + words "next session". No hook. Edit persists; takes effect after process restart.
- **No badge** — `sov config` standalone mode. There's no active session to apply to, so every edit is effectively persisted-only. Showing a badge in that mode would be misleading.

Post-edit toast:
- Live-applied: `saved — applied to current session` (green tint).
- Persisted-only: `saved — effective next session` (dim tint).
- `sov config` mode: `saved` (no tint).
- Error: `error: <message>` (red).

Toast renders as a `tea.Println` line so it lands in committed scrollback and stays visible past the modal close.

## Edge cases + error handling

1. **Schema validation failure.** Catch the Zod error on write, surface as `error: <validation message>`. Don't persist. Don't close the modal.
2. **Secret display.** `valueColumn` shows `••••••••` (8 bullets, regardless of actual length) for items with `secret: true` AND a non-empty value. Empty/unset secrets show `(unset)`.
3. **Unset action.** Each picker shows `u unset` in its footer. Pressing `u` on a selected leaf re-dispatches `/config unset <path>` and re-renders. Confirmation only if the field is reload-needed.
4. **Boolean editor.** Renders as a 2-item picker (`true` / `false`); the currently-set value is initial.
5. **Enum editor.** Renders as an N-item picker. Currently-set value is initial.
6. **Number editor.** Renders as InputCard with EchoNormal; on submit, slash handler parses with `parseValueLiteral`, schema validates as number, rejects non-numeric.
7. **Unmanaged config keys.** If `~/.harness/config.json` contains a key the catalog doesn't know about, the root menu picker shows an "Advanced (unmanaged)" group at the bottom listing them as read-only `get`-style items. Future work can extend; v0 just surfaces them so we never hide data.
8. **Esc semantics.** Esc from a picker returns to the previous menu (re-dispatches the parent `/config <group-id>` or `/config`). Esc from the root menu closes the modal (or exits in `sov config` mode).

## Testing strategy

### TS unit tests

- `tests/config/catalog.test.ts` — every group + item shape; every dotpath resolves through `findItem`; the v0 live-apply paths exist.
- `tests/config/liveApply.test.ts` — each of the 6 hooks. `theme` triggers `themeChanged`; `defaultModel` calls `setModel`; `providers.<x>.model` only fires `setModel` when `x` matches the active provider; `maxTurns` is a no-op confirm; `verbose` emits `verboseChanged`; `webSearch.*` is a no-op confirm. `sov config` mode (no commandCtx) returns `persisted-only` for all six.
- `tests/commands/configOps.test.ts` — slash dispatch for each verb: `/config` (returns root picker), `/config <group-id>` (returns submenu picker), `/config edit <path>` (returns picker OR inputOpen depending on editor kind), `/config set` (persists + fires hook), `/config unset`, plus the legacy `show`/`path`/`get` paths.

### TS integration tests

- `tests/server/configMode.test.ts` — `runConfigOnlyMode` boots the minimal server, exposes the dispatcher route, doesn't construct a runtime. Send `/config` over the wire, assert root pickerOpen comes back.
- `tests/openai/configRoute.test.ts` — not applicable (config isn't on the OpenAI surface).

### Go unit tests

- `pickercard_test.go` — extended with value-column rendering, badge rendering, secret-mask rendering, "no extras" backwards-compatible rendering.
- `inputcard_test.go` — new file. Renders with title/subtitle, accepts typed input, masks correctly when `masked: true`, returns value + command on submit.
- `app_test.go` — extended with `inputOpen` SSE case (constructs InputCard, key dispatch), `verboseChanged` case.
- `transport/input_events_test.go` — new file. Decoder for `InputOpenPayload`.

### Semantic suite

New file `tests/semantic/suites/23-config-ux.cases.ts` with cases like:

- "open `/config` and the user sees a menu, not a JSON blob"
- "user can change `taskRouting.enabled` via the menu and sees the `⟳ next session` badge"
- "user changes theme and it applies immediately"
- "user can drill into Providers > Anthropic > model and switch models"
- "user tries to set an invalid permissionMode and gets a clear error"

5 cases, leaning on the live binary via `sov drive`.

### `sov config` smoke

A `tests/cli/configMode.smoke.ts` or similar that:
- Boots `sov config`
- Sends `/config` via the dispatch route
- Asserts pickerOpen with the 10 groups + Advanced (if any unmanaged keys) comes back
- Sends `q` / SIGTERM
- Asserts clean exit code 0

## Migration

- Delete `src/ui/configMenu.ts` (the raw-mode picker).
- The `FIELDS` array in that file is superseded by the catalog — verify no other file imports `__test__.FIELDS` (one test file currently does; rewrite it against the catalog).
- `sov config show|path|get|set|unset` CLI subcommands stay exactly as they are — they don't go through the picker; they're scriptable and unchanged.
- `/config show|path|get|set|unset` slash verbs also stay (preserved as escape hatches; only the no-args invocation changes from JSON-dump to picker).

## Release

Per `docs/05-conventions/cutting-releases.md`, any change that touches `src/`, `bundle-default/`, or `packages/tui/` requires a same-session release cut so `~/.sov/bin/sov` picks up the changes. This work touches `src/` and `packages/tui/` — cut **v0.5.1** as the final task.

## Open follow-ups (Phase 2 candidates)

- More live-apply hooks: `permissionMode`, `microcompaction.*`, `compaction.*`, `review.*`, `learning.*` (read-on-demand wiring where the consuming subsystem reads config at request time).
- Hot-reload for `taskRouting.*` (rebuild lane registry; swap system prompt segment).
- Profile-scoped config (when the user is `sov -p work`, edits write to that profile's config, not the default).
- Workspace-level config layer (read `.harness/settings.json` near cwd as overrides).
- Per-config-item "what does this do?" full description (longer than the one-line `description`) displayed in a separate help pane.
- Search/jump like Approach 3 from the brainstorming — global fuzzy find across leaf fields.

## Appendix: catalog skeleton (for reference)

```typescript
// Excerpt only — the full catalog is in src/config/catalog.ts.
export const CONFIG_CATALOG: readonly ConfigGroup[] = [
  {
    id: 'general',
    label: 'General',
    items: [
      {
        path: 'defaultProvider',
        label: 'defaultProvider',
        description: 'Provider used when no --provider flag and no profile override is set.',
        editor: { kind: 'enum', choices: ['anthropic', 'openai', 'openrouter', 'ollama'] },
      },
      {
        path: 'defaultModel',
        label: 'defaultModel',
        description: 'Model used when no --model flag is supplied.',
        editor: { kind: 'string' },
        liveApply: async (value, ctx) => {
          if (!ctx.commandCtx) return 'persisted-only';
          ctx.commandCtx.setModel(String(value));
          return 'applied';
        },
      },
      {
        path: 'maxTurns',
        label: 'maxTurns',
        description: 'Runaway-loop circuit breaker. Default 100.',
        editor: { kind: 'number', min: 1 },
        liveApply: async () => 'applied',  // read-on-demand in the turn loop
      },
      // ... permissionMode, verbose
    ],
  },
  // ... 9 more groups
];
```
