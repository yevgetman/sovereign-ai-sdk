# Config live-apply UX — design (2026-06-14)

## Problem

In the live TUI `/config` flow, whether a setting takes effect in the running session is decided by a single bit — **does a `LIVE_APPLY_HOOK` exist for its dotpath?** Both the picker **badge** (`✓ live` / `⟳ next session`, `configOps.ts:407/315`) and the save **toast** (`pickToast`, `configOps.ts:902`) derive from that bit, computed independently, so they can disagree. The runtime actually has **four freeze boundaries** the binary collapses, producing the reported UX gaps:

- **Silent no-ops:** `thinking.effort` has no hook → editing it reaches neither `sessionCtx.effort` (active) nor `runtime.effort` (boot seed); even a new same-process session keeps the old value.
- **Over-claims:** `defaultModel` returns `'applied'` even when the model crosses provider families — the transport/contextLength/compactor/learning-reason stay frozen, so a foreign model id is sent to the wrong client.
- **Lying badge:** `providers.<x>.model` shows `✓ live` (badge = hook-present, static) but the hook returns `persisted-only` for a non-active provider (toast = "next session").
- **Overloaded "next session":** collapses genuinely-restart, *other-process* (`gateway.*`/`openaiServer.*`), re-applied-on-conversation-reset (`learning.*`), and pure-persistence into one message; the toast is unstyled and never names the setting.
- **Invisible orphans:** `learning.recall.*`, `providers.sov.*`, most `gateway.*` nested fields aren't in the catalog; the unmanaged safety net only catches whole new top-level keys.
- **Correctness bugs:** `refreshRuntimeFromConfig` calls bare `readConfig()` (process-global home) not `readConfig({harnessHome})` (#55-class); `COMPACTION_GROUP` description says "next session" while its fields are live; stale `app.go:1839` comment; `permissionMode` applies live with no chrome indicator (safety gap for `bypass`).

The full per-setting map (135 settings) lives in the deep-dive that produced this spec.

## Goal (the bar)

Every setting, on save, EITHER:
1. **applies immediately to the running session** — including the in-flight conversation (per the product decision: provider/model/learning changes apply to the *live* conversation), with any associated state reloaded and reflected in the chrome, and a green "applied" confirmation that **names the setting**; OR
2. where applying live is genuinely impossible, gives an **amber confirmation that names the setting AND states exactly why** (restart this process / restart the gateway-or-serve process).

No silent no-ops. No lying badges. Badge and toast always agree because both derive from one source of truth.

## Core contract — `ApplyScope`

New module `src/config/applyScope.ts`:

```ts
export type ApplyScope =
  | 'live'           // applies from the next turn this session (per-turn-read field mutated)
  | 'live-reload'    // applies this session via a bounded between-turns reload (reresolveProvider / reloadHooks / reloadMcpServers / rebuildTaskRouting / rebuildRecall)
  | 'other-process'  // consumed only by a separate `sov gateway` / `sov serve` process — no effect on this TUI session
  | 'restart';       // genuinely needs restarting THIS process (no in-process reload API); used only where justified

export interface ScopeMessage { applied: boolean; badge: 'live' | 'reload' | 'other' | 'restart'; toast: (path: string) => string; }
export function describeScope(scope: ApplyScope): ScopeMessage; // single source for badge + toast text
export function scopeIsImmediate(scope: ApplyScope): boolean;    // 'live' | 'live-reload'
```

`live` and `live-reload` both render a **green `✓ live`** badge and a green toast `✓ <path> — applied to this session`. `other-process` renders an **amber `⤴ other process`** badge and toast `saved — <path> applies to the sov gateway/serve process (not this session); restart it to take effect`. `restart` renders an **amber `⟳ restart`** badge and toast `saved — restart sov for <path> to take effect`. Standalone `sov config` keeps the plain `saved` toast.

(Note: a separate `live-rebuild` was considered for `learning.*` but, per the product decision to apply to the live conversation, `learning.*` rebuilds the active SessionContext in place → it is `live-reload`. The "next conversation" notion is dropped.)

### Where scope lives

Each setting's canonical scope is declared in a **`SETTING_SCOPES: Record<string, ApplyScope>`** map in `applyScope.ts` (dotpath → scope), co-located with `LIVE_APPLY_HOOKS` semantics. A dotpath with no entry defaults to `'restart'` (conservative — was the implicit "next session"). The badge (`configOps`) and the catalog row read `SETTING_SCOPES[path]`. Prefix scopes are supported: an entry like `gateway.*` applies to every `gateway.` sub-path (longest-prefix wins) so the orphan/uncatalogued gateway fields are still scoped.

### Hook return change

`LiveApplyHook` returns `Promise<ApplyScope>` (was `'applied' | 'persisted-only'`). Hooks return the scope they actually achieved:
- A successful live mutation returns `'live'` (or `'live-reload'` when it triggered a reload).
- Standalone (`ctx.commandCtx === undefined`) returns the setting's **declared** `SETTING_SCOPES[path]` UNCHANGED is wrong — standalone has no session, so the toast must be the plain `saved`. Hooks in standalone return a sentinel the dispatcher maps to `TOAST_SAVED_NO_SESSION` (keep current behavior: dispatcher detects `isConfigStandalone` and shows plain `saved` regardless of hook).
- A genuinely-deferred field has **no hook** and its `SETTING_SCOPES` entry is `restart` or `other-process`; the dispatcher reads the map for the toast.

Invariant: **the badge (`SETTING_SCOPES[path]`) and the live outcome must match.** A hook that can only sometimes apply live (e.g. provider model when reresolve is unavailable) must be wired so its declared scope is achievable; otherwise declare `restart`. This kills the lying badge.

## Mechanisms to add (maximize the live set)

### M1 — `runtime.reresolveProvider()` (keystone, `src/server/runtime.ts`)
Re-runs `resolveProvider(provider, model, { harnessHome })` for the active provider+model, then **atomically swaps between turns** (guard: never mutate mid-turn — apply before the next `runOnce`): `runtime.resolvedProvider.{transport,contextLength,metadata}`, `runtime.provider`, `runtime.model`, the compactor's captured model, and `learningLayer.reason` (rebuilt via `createProviderReason(resolved.transport, resolved.model)`). Exposed on `CommandContext` as `reresolveProvider?(provider?, model?) => Promise<void>`. Converts to `live-reload`: `defaultModel` (cross-family), `defaultProvider`, `providers.<active>.{model,apiKey,baseUrl}`, and `router.*` (re-resolve the RouterProvider's lanes). Same-family `defaultModel`/`providers.<x>.model` stay the cheap path (`setModel` only) but are still reported `live`. A non-active `providers.<x>.model` edit is `live-reload` only if `<x>` is or becomes active; otherwise it's a future-default → report `live` (persisted; takes effect when you switch to that provider, which itself reresolves) — and the badge says `✓ live` honestly because switching providers will pick it up. Document this precisely in the hook.

### M2 — `reloadHooks()` / `reloadMcpServers()` (`src/server/runtime.ts`)
Mirror `rebuildTaskRouting` (mutate `runtime.toolPool` / `runtime.hookRunner` / `runtime.systemSegments` IN PLACE so per-turn readers pick them up next turn): `reloadHooks()` rebuilds the `HookRunner` from fresh config and reassigns `runtime.hookRunner`; `reloadMcpServers()` reconnects the MCP client pool, rebuilds the MCP slice of `runtime.toolPool`, and recomputes tool visibility. Exposed on `CommandContext`. `mcpServers` + `hooks` (settings.json) → `live-reload`. (These live in settings.json, not the catalog field UI today; the catalog need not surface them, but the mechanism + scope map must classify them so a future surface is honest.)

### M3 — `thinking.effort` hook (`src/config/liveApply.ts`)
Calls `commandCtx.setEffort(value)` (mutates `sessionCtx.effort` → live next turn + emits `effortChanged` for the status chrome) AND updates `runtime.effort` (the future-session seed). Scope `live`. Fixes the #1 silent no-op; unifies `/config` with `/effort`.

### M4 — `rebuildRecall()` (`src/server/sessionContext.ts` + `commandContext.ts`)
Rebuilds the ACTIVE `SessionContext`'s recall thunk + learning observer in place from fresh config (mirrors `buildSessionContext`'s recall/observer wiring). Exposed on `CommandContext`. `learning.recall.*`, `learning.disabled`, learning synthesis cadence → `live-reload`. Must respect founder-reserved defaults (recall ON) — it only re-reads the user's persisted values, never changes semantics.

### M5 — sentinel/`refreshRuntimeFromConfig` hooks for read-on-demand fields (`src/config/liveApply.ts`)
For fields whose runtime read-site already re-reads per request/spawn (confirm each during implementation): `behavior.maxToolCallsBeforeCheckin`, `maxTurns`, `review.*`, `learning` confidence/prune/synthesis tunables, `subscriptionExecutor.*`, `providers.ollama.numCtx`. Add a `live` hook (sentinel that returns `'live'`, or routes through an extended `refreshRuntimeFromConfig` that re-reads the relevant runtime cache). Any field whose read-site is NOT per-request stays `restart` with an honest message.

### M6 — render-flag side-effects for `ui.*` (5 wire seams each)
New `CommandSideEffects` fields (`src/server/schema.ts`) + `routes/commands.ts` `hasSideEffects`/`pickSideEffects` + Go `transport/commands.go` decode + `app.go` apply: `permissionModeChanged?: string`, `toolOutputChanged?: { mode?, inlineLines? }`, `footerChanged?: boolean`, `contextMeterChanged?: { warnAtPercent?, dangerAtPercent? }`, `diffRenderChanged?: boolean`. Per the project rule, each new side-effect MUST thread all five seams (collector, `hasSideEffects`, `pickSideEffects`, schema, Go decoder). `ui.toolOutput.*`, `ui.footer.*`, `ui.contextMeter.*`, `ui.diffRender.*` → `live` (relayed to the Go renderer like `verbose`/`theme`).

## Messaging + reflection

- **Badge** (`configOps.ts` picker rows AND headless fallback): read `SETTING_SCOPES[path]` → `describeScope().badge` (4 states). Thread the badge into `InputOpenConfigSchema` so free-text (string/number/secret) fields show the same affordance as picker rows.
- **Toast**: `pickToast` reads the resolved scope (hook's returned `ApplyScope`, falling back to `SETTING_SCOPES[path]` when no hook), names the setting, styles by scope. Port `runUnset`'s path-naming to `runSet`.
- **Reflection**: status line already updates for model/effort/taskRouter. Add: a **`permissionModeChanged` indicator** (loud marker for `bypass` — safety), refresh the **context meter** when a provider/model reresolve changes `contextLength`, and re-render via the M6 `ui.*` side-effects. Remove the stale `app.go:1839` comment.

## Coverage fixes

- Add catalog entries: `learning.recall.{enabled,maxLessons,tokenBudget}` (LEARNING_GROUP), a `providers.sov.*` subgroup (model + baseUrl), and the missing `gateway.*` fields (`corsOrigins`, `eventBufferSize`, `idleSessionTimeoutMs`, `idleSweepIntervalMs`, `maxConcurrentSessions`) scoped `other-process`. `gateway.principals` + `gateway.channels.*` secrets stay hand-edit-only (documented).
- Fix `listUnmanagedKeys` to recurse into sub-keys so partially-catalogued blocks don't hide orphan sub-fields.
- Fix `COMPACTION_GROUP` description ("next session" → live) and `ui.theme` copy; bind the user-facing theme picker row to the `theme` dotpath that has the hook.

## Correctness fixes

- `refreshRuntimeFromConfig` (`commandContext.ts:244`): `readConfig()` → `readConfig({ harnessHome: runtime.harnessHome })`.
- Provider-model badge lie: resolved by the scope map (badge == achievable outcome).

## Genuine residue (after maximizing)

- `other-process`: `gateway.*`, `openaiServer.*` — honest amber message, NOT a restart of the TUI.
- `restart` (only where there is no in-process reload API, each justified in the scope map): `debugMode.{enabled,transcript,transcriptDir}` (transcript writer opened at session start — could be re-opened later but low value; leave `restart` v1), `learning.observationBufferSize` (buffer allocated at build), `router.maxConcurrent{Local,Frontier}` + subagent concurrency caps (`LaneSemaphores` has no `setLimit`; leave `restart` v1 — a follow-up could add a resize API). Everything else is `live` or `live-reload`.

## Testing

- Unit: `applyScope` (`describeScope`/`scopeIsImmediate`/prefix resolution); every new hook (effort, sentinels, learning rebuild, provider reresolve via a mock runtime) returns the right scope; badge==toast scope agreement; `listUnmanagedKeys` recursion; the `harnessHome` fix.
- Server: `reresolveProvider` swaps the provider stack and the next turn uses the new transport (MockProvider family swap); `rebuildRecall` re-reads recall config; a turns-route test that a `/config set defaultModel` mid-session changes the model the live conversation uses.
- Go: side-effect decode + apply for each new field; permissionMode indicator; InputCard badge; status-line reflections.
- Semantic/behavioral: a `sov drive` headless smoke that sets a representative field of each scope and asserts the toast/behavior.

## Milestones — see `plans/2026-06-14-config-live-apply.md`.
No new ADRs (additive; decisions captured here). Built per ADR H-0010 (vendor-neutral runtime).
