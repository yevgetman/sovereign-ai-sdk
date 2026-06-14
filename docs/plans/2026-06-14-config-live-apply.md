# Config live-apply UX — plan (2026-06-14)

Spec: `docs/specs/2026-06-14-config-live-apply-design.md`. Build target: every `/config` save either applies live to the running session (with reflection + green confirmation naming the setting) or gives an amber confirmation naming the setting + why (restart this process / the gateway/serve process). Apply-to-live-conversation confirmed.

## Dependency order + file ownership (disjoint for the parallel wave)

**T1 — Foundation (the contract; landed first, others build on it).** Owner: orchestrator.
- NEW `src/config/applyScope.ts`: `ApplyScope` type, `SETTING_SCOPES` map (dotpath/prefix → scope, every catalogued + orphan path), `describeScope`, `scopeIsImmediate`, longest-prefix resolver `scopeFor(path)`.
- `src/commands/types.ts`: extend `CommandContext` with `reresolveProvider?`, `reloadHooks?`, `reloadMcpServers?`, `rebuildRecall?` (signatures only).
- `src/server/schema.ts`: add the M6 side-effect fields + extend `LiveApplySideEffect` (`src/config/liveApply.ts`) with the new relay fields; add `badge` to `InputOpenConfigSchema`.
- `src/config/liveApply.ts`: change `LiveApplyHook` return to `Promise<ApplyScope>`; update existing hooks to return `'live'`/`'live-reload'`; add the `thinking.effort` hook (M3). (Hook BODIES that call new CommandContext methods can call the now-typed optional methods.)

**T2 — Messaging + badge unification.** Owner: A. Files: `src/commands/configOps.ts`, `src/cli/configMode.ts`.
- Badge + `pickToast` derive from `scopeFor(path)` / the hook's returned `ApplyScope`; toast names the setting + scope-styled; port unset path-naming to set; thread `badge` into the emitted InputCard config. Add a 4th+ toast vocabulary (live / other-process / restart / saved).

**T3 — Reload engine (TS runtime).** Owner: B. Files: `src/server/runtime.ts`, `src/server/commandContext.ts`, `src/server/sessionContext.ts`.
- M1 `reresolveProvider`, M2 `reloadHooks`/`reloadMcpServers`, M4 `rebuildRecall`; wire the matching `CommandContext` closures; fix the `refreshRuntimeFromConfig` `harnessHome` bug (#55-class).

**T4 — Hooks wiring + scope coverage.** Owner: C. Files: `src/config/liveApply.ts` (hooks added in T1 region — sequenced after T1; this owner extends), `src/config/catalog.ts`.
- Wire provider/router/mcp/hooks hooks to T3's methods (M1/M2); add M5 sentinel hooks for read-on-demand fields (confirm read-sites); learning hooks call `rebuildRecall` (M4). Catalog: orphan fields (`learning.recall.*`, `providers.sov.*`, missing `gateway.*`), `listUnmanagedKeys` recursion, group-description fixes. (NOTE: `liveApply.ts` + `catalog.ts` are touched by T1 too — T4 runs AFTER T1; single owner for catalog.ts.)

**T5 — Wire seams (server).** Owner: D. Files: `src/server/routes/commands.ts`.
- `hasSideEffects`/`pickSideEffects` enumerate the M6 fields + `permissionModeChanged`.

**T6 — Go TUI reflection.** Owner: E. Files: `packages/tui/internal/transport/commands.go`, `packages/tui/internal/app/app.go`, `packages/tui/internal/components/{statusline,inputcard,pickercard}.go`.
- Decode + apply the new side-effects; `permissionMode` indicator (loud for bypass); InputCard scope badge; 4-state picker badge; refresh context meter on contextLength change; remove stale comment.

**T7 — Tests** (each owner adds tests for their area; orchestrator adds the cross-cutting ones): `applyScope`, hook scopes, badge==toast, `reresolveProvider` family swap + live-conversation model change, `rebuildRecall`, `listUnmanagedKeys` recursion, harnessHome fix, Go side-effect decode/apply.

**T8 — Integrate + gate + adversarial review + docs + ship.** Owner: orchestrator. Full clean-env gate (lint/typecheck/test/go test); review (spec-compliance + code-quality + a focused safety review of `reresolveProvider`'s mid-session provider-stack swap); update `usage.md` config section; testing-log; backlog (#59/#60 unrelated; note this build); commit/push; `sov upgrade`; cut release.

## Parallelization
T1 first (foundation). Then T2/T3/T5/T6 in parallel (disjoint files), with T4 after T1 (shares catalog.ts/liveApply.ts ownership). Orchestrator reconciles T1↔T3↔T4 interface seams centrally + runs the gate. Reviews after green.
