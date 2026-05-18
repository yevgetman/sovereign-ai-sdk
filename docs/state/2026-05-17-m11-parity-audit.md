# Phase 16.1 M11 — Default-flip Parity Re-audit (signed-off report)

**Date:** 2026-05-17
**Audit type:** Independent re-audit per Postmortem Rule 3. Verifies M10 HIGH gaps remain closed and M11 default-flip changes introduce no new gaps.
**Methodology:** Single Opus subagent reading the code, not by recall. M10's 4-agent slice-by-slice methodology was already executed at 2026-05-16; this re-audit is a focused delta verification covering (a) the four M10 HIGH gaps' close-out state and (b) a fresh import-scan of the M11 commit range (`d2de19b..HEAD`).
**Predecessor:** [`docs/state/2026-05-16-tui-parity-audit.md`](./2026-05-16-tui-parity-audit.md), [`docs/state/2026-05-16-m10-5.md`](./2026-05-16-m10-5.md)
**Spec:** [`docs/specs/2026-05-17-phase-16-1-m11-default-flip-design.md`](../specs/2026-05-17-phase-16-1-m11-default-flip-design.md)
**Plan:** [`docs/plans/2026-05-17-phase-16-1-m11-default-flip.md`](../plans/2026-05-17-phase-16-1-m11-default-flip.md)

## Executive summary

| Finding | Count | M11 close-out impact |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 (4 prior HIGH gaps from M10 audit all closed/scope-bounded) | — |
| MEDIUM | 0 (new — pre-existing #41, #43, #44 unchanged from M10.5 disposition) | — |
| LOW | 1 (stale documentation in `docs/conventions/sov-upgrade.md`) | Non-blocking; documentation polish |
| New M11 code surface area | 2 modules (~157 LoC source + ~189 LoC tests) | All clean |

**M11 disposition: PASS-with-followups.** Of the 4 HIGH gaps surfaced in the M10 audit, three are closed (HarnessInfoTool wired, repairMissingToolResults wired, slash-command dispatcher route shipped via M10.5) and one remains intentionally scope-bounded (mission FSM CLI-only — disposition unchanged). The M11 default-flip code surface (surfaceResolver + main.ts flip + schema field + tests) passes fresh import-scan with no new wiring gaps. One LOW-severity documentation drift in `docs/conventions/sov-upgrade.md:19` references "`sov --ui repl` (the default)" which is no longer accurate post-M11; recommend correcting in the M11 close-out doc pass.

The M10.5 cascading deferred items (#41, #43, #44) remain correctly scope-bounded with informative-output messages intact in `src/server/commandContext.ts:97-100`; M11 did not regress them.

## Postmortem-rule compliance verification

- **Rule 1 — `src/ui/terminalRepl.ts` untouched:** verified. `git diff d2de19b..HEAD -- src/ui/terminalRepl.ts` returns empty.
- **Rule 2 — no helper module deletion:** verified. `git diff d2de19b..HEAD --diff-filter=D -- src/` returns empty.
- **Rule 3 — audit by reading the code, not recall:** done by this re-audit. Per-task verdicts cite file:line for every claim.
- **Rule 4 — flag-based safety net preserved across the flip:** verified. Four escape hatches survive (CLI `--ui repl`, env `SOV_UI=repl`, config `ui.surface=repl`, auto-fallback to REPL when `sov-tui` binary missing). All four are visible in `src/cli/surfaceResolver.ts:49-76` (precedence chain) + `src/main.ts:221-230` (missing-binary fallback).

## Audit task 1 — M10 HIGH gap close-out verification

### HIGH #1 — HarnessInfoTool wired into server-mode tool pool

**Status: CLOSED in M10 (commit `53fda9e`); verified intact post-M11.**

`src/server/runtime.ts:469-545` shows the lazy snapshot getter mirrored from `terminalRepl.ts:668-727`, with the `*Ref` closure-capture pattern:

```ts
// line 476-477
let finalToolPoolRef: Tool<unknown, unknown>[] = [];
let systemSegmentsRef: SystemSegment[] = [];
const harnessInfoSnapshot = (): HarnessInfoSnapshot => { ... };
// line 545
let toolPool = assembleToolPool(toolCtx, { mcpTools, harnessInfoSnapshot });
finalToolPoolRef = toolPool;
```

The snapshot is constructed at tool-call time, reads permission settings live (`src/server/runtime.ts:479-480`), and aggregates MCP server status, tool pool, agents, and context-budget data. The intentional `slashCommands: []` choice at line 523 is documented inline (server has no client-side slash registry) — this design hasn't drifted in M11.

### HIGH #2 — repairMissingToolResults wired into server resume path

**Status: CLOSED in M10 (commit `a892f71`); verified intact post-M11.**

`src/server/routes/turns.ts:28` imports `repairMissingToolResults`. The hydrate wrapper at `src/server/routes/turns.ts:327-336` calls it after `loadHistoryAsMessages`:

```ts
const hydrate = (): Message[] => {
  const raw = loadHistoryAsMessages(runtime.sessionDb, sessionId);
  const { messages: repaired, insertedToolResults } = repairMissingToolResults(raw);
  if (insertedToolResults > 0) {
    process.stderr.write(
      `[repair] synthesized ${insertedToolResults} missing tool_result block(s) for session ${sessionId}\n`,
    );
  }
  return repaired;
};
```

Wrapped lazily per the M10 audit's recommendation (additive, idempotent). The repair fires only when an orphaned `tool_use` is detected, mirroring `terminalRepl.ts:2129`.

### HIGH #3 — slash-command dispatcher (server-side `/commands` route)

**Status: CLOSED in M10.5 (commits `17d456b` + `d515b9f`); verified intact post-M11.**

Files exist and are wired:
- `src/server/routes/commands.ts` (5.7KB) — defines `commandsRoute` with `POST /sessions/:id/commands { name, args }`.
- `src/server/commandContext.ts` (9.5KB) — `buildServerCommandContext(runtime, sessionCtx, sessionId)` constructs a per-request `CommandContext` (line 60), returns `{ ctx, sideEffects }`.
- `packages/tui/internal/transport/commands.go` (4.5KB) — Go transport client mirroring the wire shape.
- `packages/tui/internal/app/slashrouter.go` (2.8KB) — slash router with precedence: `/theme` → `/compact` → `/expand` → `/skills` → known skill name → generic `/commands` → fallthrough.

Mounted at `src/server/app.ts:37`:

```ts
// M10.5 — POST /sessions/:id/commands, generic slash-command dispatcher.
// Closes M10 audit slice 1 HIGH gap; unblocks M11.
app.route('/', commandsRoute(runtime));
```

The dispatcher uses the same closure-collector pattern for `sideEffects.modelChanged` / `sideEffects.exitRequested`, allowing the route to surface state mutations back to the TUI (`src/server/commandContext.ts:108-178`).

### HIGH #4 — mission FSM CLI-only

**Status: SCOPE-BOUNDED (intentional disposition from M10 audit, unchanged).**

`grep -rn "applyTransition\|missionInit\|notesMdPath\|mission" src/server/` returns zero matches against mission FSM symbols (only permission/mission-unrelated matches). The primary mission entry is `sov mission run` CLI in `src/cli/missionRun.ts` (verified via `grep` earlier). Per M10 audit §"slice 2 / mission scope-bounded disposition", this remains intentional — the TUI never had a mission entry point. No drift from M10's signed-off classification.

## Audit task 2 — Fresh import-scan of M11 commit range

M11 commit range (`git log d2de19b..HEAD`):
- `4e6ef3d` — docs only (spec + plan)
- `be73eba` — `src/config/schema.ts` (5-line add) + `tests/config/schema.test.ts` (8-line add)
- `18c5033` — `src/cli/surfaceResolver.ts` (new, 76 LoC) + `tests/cli/surfaceResolver.test.ts` (new, 181 LoC)
- `5a1291d` — `src/main.ts` (31 lines changed at lines 182, 199-236)
- `0b528f3` — `README.md` + `docs/usage.md` doc updates

### `src/cli/surfaceResolver.ts` (new module)

Read in full. Findings:

- **Pure function.** No I/O; caller passes config + env explicitly (`src/cli/surfaceResolver.ts:11-12`). Trivially testable; testable by injection (`stderr?: (m: string) => void` at line 40).
- **Precedence order correctly implemented:** CLI (line 53-60) → env (line 62-66) → config (line 68-71) → default 'tui' (line 75). Matches spec §4.1.
- **Invalid CLI emits one-line warning** (`src/cli/surfaceResolver.ts:57-59`): `sov: unknown --ui value '<x>' (expected 'tui' or 'repl'); falling back to env/config.\n`. Tests cover this at `tests/cli/surfaceResolver.test.ts:46-67`.
- **Invalid env silently falls through** (no `stderr.write` in the env branch). Tests verify at `tests/cli/surfaceResolver.test.ts:94-115`.
- **Type guard `isSurface(value)`** uses a `ReadonlySet<Surface>` at line 43-47 — correctly narrows to the literal union.
- **Coding-style compliance.** Immutable return values (object literals at lines 55, 65, 71, 75). KISS — straight-line conditional chain. Named types (`Surface`, `SurfaceResolution`, `SurfaceResolverInput`). Explicit types on the exported function (line 49). No `any`. Per the user's `~/.claude/rules/ecc/typescript/coding-style.md`, this module is clean.

**No HIGH/CRITICAL/MEDIUM findings.**

### `src/main.ts` (the key file)

Read full action handler at `src/main.ts:199-257`. Verifications per the audit brief:

1. **Resolver called BEFORE any side-effects.** Verified. The handler runs in this order:
   - Line 202-206: deprecation notice for `sov chat` (stderr only — informational, no state change).
   - Line 209-214: resolver call.
   - Line 221-230: missing-binary fallback (stderr only if triggered).
   - Line 232-236: TUI branch.
   - Line 237-256: REPL branch.
   No DB/network/filesystem side-effects fire before resolution.

2. **Missing-binary check correctly placed.** `findTuiBinary() === null` is gated behind `effectiveSurface === 'tui'` (line 221), so a `--ui repl` user never pays the binary-resolve cost or sees the warning.

3. **REPL fallback preserves full REPL invocation path.** Lines 237-256 are bit-for-bit equivalent to the pre-M11 REPL invocation block (verified via `git diff d2de19b..HEAD -- src/main.ts` — the only diff in that block is the surrounding `if (opts.ui === 'tui')` switching to `if (effectiveSurface === 'tui')`). All flags forwarded:
   - bundlePath, providerName, model, maxTokens, permissionMode
   - resumeId, dbPath, noCache, preflight, transcriptPath
   - verbose, legacyInput, captureFixturePath, replayFixturePath
   - agentName, stateDir

4. **TUI invocation unchanged.** Line 233-235: `runTuiLauncher(opts)` receives the raw `opts` bag — unchanged from pre-M11.

5. **No subsystem silently disabled.** The new control flow only routes between two pre-existing paths. No subsystem teardown or init is skipped.

**Subtle defensive-guard finding (informational, NOT a bug):** `src/cli/tuiLauncher.ts:124-136` retains its internal null-binary check returning exit 70. Post-M11, this branch is unreachable from the bare-`sov` flow (main.ts pre-checks at line 221-230). The internal guard is harmless (belt-and-suspenders) and not a regression. The warning text at `tuiLauncher.ts:130-133` is now inconsistent with the M11 behavior — recommend updating in a follow-up doc pass, but not blocking.

**No HIGH/CRITICAL/MEDIUM findings on `src/main.ts`.**

### `src/config/schema.ts` (5-line add)

`src/config/schema.ts:103-107`:

```ts
/** M11 — persistent foreground-surface preference. Resolved at
 *  `sov` boot via the precedence: CLI --ui flag > env SOV_UI >
 *  this field > 'tui' default. Recoverable via
 *  `sov config unset ui.surface`. */
surface: z.enum(['tui', 'repl']).optional(),
```

Inside `UiSchema` (line 57). Optional — schema permits `ui` object without `surface`. `tests/config/schema.test.ts:77-83` validates accept/reject:

```ts
test('ui.surface accepts tui | repl (M11 default-flip persistent opt-out)', () => {
  for (const surface of ['tui', 'repl']) {
    expect(() => SettingsSchema.parse({ ui: { surface } })).not.toThrow();
  }
  expect(() => SettingsSchema.parse({ ui: { surface: 'web' } })).toThrow();
  expect(() => SettingsSchema.parse({ ui: { surface: 123 } })).toThrow();
});
```

Clean. Strict-mode parsing rejects unknown values + non-string. No drift.

### `README.md` + `docs/usage.md` (doc updates)

`git diff d2de19b..HEAD -- README.md docs/usage.md` reviewed. The `--ui` flag description updated correctly:
- `README.md:32` — Go-tool requirements correctly call out the new default + the auto-fallback safety net.
- `README.md:126` — `--ui <tui|repl>` (default `tui` as of M11) with persistence guidance.
- `docs/usage.md:78-80` — Section header updated with M11 default-flip note + alternative opt-out paths.
- `docs/usage.md:107` — bare `sov` entry table row updated to mention default `--ui tui` + fallback behavior.

## Audit task 3 — M10.5 cascading items (#41, #43, #44)

**Status: scope-bounded, not regressed.**

`grep -n "memoryManager\|createDefaultMemoryManager\|appendProjectLocalPermissionRule" src/server/commandContext.ts src/server/sessionContext.ts` returns zero — confirming none are wired in server-mode (as expected per M10.5 disposition).

`src/server/commandContext.ts:97-100` retains the informative-output messages:

```ts
const UNWIRED_CLEAR_MSG =
  '/clear is not yet available in --ui tui (M10.5 scope-out; tracked as backlog item #41 — createClearedChildSession server wiring). Use `sov chat --ui repl` for now, or compact instead (/compact).';
const UNWIRED_ROLLBACK_MSG =
  '/rollback is not yet available in --ui tui (M10.5 scope-out; tracked as backlog item #41). Use `sov chat --ui repl` for now.';
```

`src/server/commandContext.ts:112,123` wire these messages to `clearHistory` and `rollback` respectively. Item #43 (memory manager) and #44 (permission rule persistence) are not surface-exposed via a command method, so no message wiring is needed; their absence remains correctly tracked in the backlog.

Note: the informative messages still reference `sov chat --ui repl`, but the M11 spec changes the canonical opt-out to `sov --ui repl` or `sov config set ui.surface repl`. This is a minor (LOW) doc-style drift that doesn't affect functionality — `sov chat --ui repl` and bare `sov --ui repl` both work since `chat` is still a (deprecated) subcommand alias. Recommend updating these strings in a follow-up polish pass, but not blocking M11.

## Audit task 4 — Grep for leftover `--ui repl` default assumptions

Pattern: `'repl'.*default | default.*'repl' | opts\.ui === 'repl' | --ui repl.*default` against `src/` + `tests/` + `docs/`.

Findings:

- **Source code:** zero matches in `src/` (verified — only legitimate uses such as error messages reference `--ui repl`, none assume it's the default).
- **Test code:** zero matches in `tests/` (verified — references in `tests/server/runtime.hooks.test.ts:6` + `tests/cli/tuiLauncher.test.ts:367,372` are in comments / error-string assertions, not default-assumption checks).
- **Active docs (`docs/specs/`, `docs/plans/` from M11, `docs/state/2026-05-1[7-]`):** correctly updated.
- **Stale docs:**
  - **LOW finding — `docs/conventions/sov-upgrade.md:19`** still says "If Go is missing, the install succeeds and `sov --ui repl` (the default) still works". This is now inaccurate post-M11 (bare `sov` defaults to `--ui tui`; if `sov-tui` is missing, the new M11 auto-fallback fires). Recommend updating this convention file in the M11 close-out commit so newer sessions reading the convention don't get a stale picture.
  - Historical references in `docs/plans/2026-05-1[3-6]-*.md`, `docs/specs/2026-05-13-*.md`, `docs/testing-log.md`, and `docs/state/archive/` correctly preserve the pre-M11 default in narrative form. These should NOT be retroactively edited — they're history.

## Audit task 5 — Postmortem rules 1, 2, 4 explicit checks

- **Rule 1:** `git diff d2de19b..HEAD -- src/ui/terminalRepl.ts` returns empty. ✓
- **Rule 2:** `git diff d2de19b..HEAD --diff-filter=D -- src/` returns empty. ✓
- **Rule 4 — three CLI/env/config escape hatches + auto-fallback:**
  - **CLI `--ui repl`:** `src/main.ts:182` flag still defined (no default); `src/cli/surfaceResolver.ts:53-56` returns `{ surface: 'repl', source: 'cli' }` when `cliFlag === 'repl'`.
  - **Env `SOV_UI=repl`:** `src/cli/surfaceResolver.ts:62-66` reads from `input.env ?? process.env`; returns `{ surface: 'repl', source: 'env' }` when `SOV_UI === 'repl'`.
  - **Config `ui.surface=repl`:** `src/cli/surfaceResolver.ts:68-71` reads `input.config?.ui?.surface`; returns `{ surface: 'repl', source: 'config' }` when set.
  - **Auto-fallback:** `src/main.ts:221-230` switches `effectiveSurface` from `tui` to `repl` when `findTuiBinary() === null`, with a one-line stderr warning citing the remediation command.

All four pathways verified via source-read.

## Audit task 6 — Severity-classified findings + M11 disposition

| Severity | Count | Items |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 1 | `docs/conventions/sov-upgrade.md:19` stale "`sov --ui repl` (the default)" reference + minor `sov chat --ui repl` references in `src/server/commandContext.ts:98,100` could mention bare-`sov` opt-out for clarity |

**M11 close-out disposition: PASS-with-followups.** No CRITICAL/HIGH/MEDIUM gaps. The 1 LOW finding is documentation polish, not a code issue.

## Suite-level verification

Test suite ran clean against the M11 HEAD:
- **2033 pass / 0 fail / 5211 expect()** across 252 files (M10.5 baseline 2018 + 15 new M11 tests: 16 surfaceResolver + 1 schema field).
- Surface-resolver suite: 16 tests covering all precedence layers + invalid CLI/env/config + process.env fallback.
- Config-schema suite: 1 new test covering accept/reject for `ui.surface`.

Postmortem-rule compliance, M10 HIGH gap closure, M11 code surface, and M10.5 cascading items all verified.

## Recommended follow-ups (non-blocking, LOW severity)

1. **Update `docs/conventions/sov-upgrade.md:19`** to reflect the M11 default-flip — change `"sov --ui repl" (the default)` to `"bare sov" (which defaults to --ui tui as of M11, with auto-fallback to readline REPL when sov-tui is missing)`.
2. **Update the `sov chat --ui repl` strings in `src/server/commandContext.ts:98,100`** to also mention bare `sov --ui repl` or `sov config set ui.surface repl` as the canonical opt-outs post-M11.
3. **Optional cleanup:** the now-unreachable `tuiLauncher.ts:124-136` null-binary branch can be left as a defensive guard (it's a no-op given main.ts pre-checks); the stale warning text inside it (`'sov: TUI binary not found — install Go ≥ 1.24 ...'`) is functionally dead but worth correcting for any future direct importer.

All three are documentation/string polish — no functional code changes required.

## Sign-off

This audit verifies that:
- The 3 M10 HIGH gaps requiring code fixes (HarnessInfoTool, repairMissingToolResults, slash-command dispatcher) remain closed.
- The 1 M10 HIGH gap classified as intentional scope-bound (mission FSM CLI-only) remains intentional.
- The M11 default-flip code surface introduces no new HIGH/CRITICAL/MEDIUM wiring gaps.
- The M10.5 cascading deferred items (#41, #43, #44) remain correctly scope-bounded with informative-output messages intact.
- Postmortem rules 1, 2, 4 are all honored.

**M11 milestone status: PASS (close-out authorized) — with one LOW-severity documentation polish recommended in the close-out commit.**

---

**Audit performed against HEAD `0b528f3` (M11 commit chain: `4e6ef3d` → `be73eba` → `18c5033` → `5a1291d` → `0b528f3`). Suite baseline at audit: 2033 pass / 0 fail / 5211 expect() across 252 files.**
