# Phase 16.1 M12 — Readline REPL deprecation warning

**Date:** 2026-05-19
**Status:** Pending plan-execution authorization.
**Predecessor:** M11 default-flip (`docs/state/2026-05-17-m11.md`), M11.5 inline picker card (`docs/state/2026-05-19-m11-5.md`).
**Driver:** ADR M11-03 — M11 deliberately left `--ui repl` silent; M12's job is to start the deprecation clock.

## 1. Purpose

With M11 shipping the TUI as the default and M11.5 closing the M10-audit P2 gaps that made `--ui tui` actually usable (slash commands, inline pickers, `/clear`, `/rollback`, `/memory`), the readline REPL surface no longer has a feature gap blocking deprecation. M12 emits a one-line deprecation warning when a user **explicitly** opts into `--ui repl` (CLI flag, env `SOV_UI=repl`, or config `ui.surface=repl`). M13 will remove `src/ui/terminalRepl.ts` entirely once M12 has soaked.

The warning is **NOT** emitted when the missing-binary fallback flips `effectiveSurface` from `tui` to `repl`. That's a system-driven soft-degradation, not a user choice — warning would punish users whose only "mistake" was not having Go installed.

## 2. Scope

**In scope (M12):**
- One-line stderr deprecation warning at REPL boot when `resolution.surface === 'repl'`.
- Env-var suppression: `SOV_NO_DEPRECATION_WARNING=1` skips the warning. Power users / scripted CI / users who can't migrate yet have a one-token escape.
- Helper function `formatReplDeprecationMessage(input)` extracted for unit-testability; called from `src/main.ts` before `runRepl(...)`.
- README + `docs/usage.md` updated to call `--ui repl` deprecated and point at the M13 removal timeline.
- Smoke rerun of the 13 M11 boot-decision scenarios with the new messaging captured.
- 2 ADRs (M12-01, M12-02).

**Out of scope:**
- Any removal of `src/ui/terminalRepl.ts` or the readline helpers. That's M13.
- Any change to the missing-binary fallback path's stderr line — M11's wording stays.
- Any change to the TUI experience. M12 only affects REPL boot.
- Suppression via config file. Env var is the only suppression mechanism; adding a config field would be over-engineered for a deprecation that's meant to be temporary (M13 removes the surface entirely).
- Behavior changes inside the REPL itself. Once it's booted, M12 is invisible.

## 3. Architecture

```
src/main.ts .action handler (post-M11.5 state)
  ↓
  resolution = resolveSurface({...})       // { surface, source }
  ↓
  // M12 — emit deprecation when user explicitly chose REPL
  if (resolution.surface === 'repl') {
    const msg = formatReplDeprecationMessage({ source: resolution.source, env: process.env });
    if (msg !== null) process.stderr.write(msg);
  }
  ↓
  let effectiveSurface = resolution.surface;
  // M11 missing-binary fallback (unchanged):
  //   if effectiveSurface === 'tui' && sov-tui missing → flip to 'repl' + stderr warning
  ↓
  branch on effectiveSurface
```

**Key distinction:** the M12 warning fires from `resolution.surface`, not `effectiveSurface`. The fallback path has `resolution.surface === 'tui'` (user picked TUI or got default-TUI), so M12 stays silent. Only explicit `--ui repl` / `SOV_UI=repl` / `ui.surface=repl` reach `resolution.surface === 'repl'`.

## 4. Components

### 4.1 `formatReplDeprecationMessage` helper (NEW)

**File:** `src/cli/replDeprecation.ts` (new, ~40 LoC).

```typescript
import type { SurfaceSource } from './surfaceResolver.js';

export interface FormatReplDeprecationInput {
  source: SurfaceSource;
  env: NodeJS.ProcessEnv;
}

/** Returns the deprecation warning text (with trailing newline) when one
 *  should be emitted, or null when it should be suppressed. M12. */
export function formatReplDeprecationMessage(input: FormatReplDeprecationInput): string | null {
  if (input.env.SOV_NO_DEPRECATION_WARNING === '1') return null;
  // The 'default' source is unreachable here (post-M11, default is 'tui'),
  // but we belt-and-suspenders against any future shift back to default-
  // repl by suppressing rather than mis-warning.
  if (input.source === 'default') return null;
  const sourceLabel = sourceToLabel(input.source);
  return (
    `sov: the readline REPL is deprecated and will be removed in M13.\n` +
    `     (you opted in via ${sourceLabel} — the TUI is the default and now feature-complete).\n` +
    `     set SOV_NO_DEPRECATION_WARNING=1 to silence this warning.\n`
  );
}

function sourceToLabel(source: SurfaceSource): string {
  switch (source) {
    case 'cli':
      return '--ui repl';
    case 'env':
      return 'SOV_UI=repl';
    case 'config':
      return 'ui.surface=repl';
    case 'default':
      // Unreachable per the M11 default; preserved for type exhaustion.
      return 'default';
  }
}
```

The helper is pure: takes the resolved source + env, returns the message or null. Easy to unit-test against all four source values + with/without suppression flag.

### 4.2 `src/main.ts` (CHANGED)

Add a single block right after `const resolution = resolveSurface(...)` and BEFORE the missing-binary-fallback check:

```typescript
// M12 — REPL deprecation warning. Fires when the user explicitly opted
// into --ui repl / SOV_UI=repl / ui.surface=repl. Stays silent when the
// missing-binary fallback flipped effectiveSurface (resolution.surface
// remains 'tui' in that case). ADR M12-01.
if (resolution.surface === 'repl') {
  const { formatReplDeprecationMessage } = await import('./cli/replDeprecation.js');
  const msg = formatReplDeprecationMessage({ source: resolution.source, env: process.env });
  if (msg !== null) process.stderr.write(msg);
}
```

Dynamic import matches the pattern used for `resolveSurface` already at line 209 — keeps `main.ts`'s eager import surface lean.

### 4.3 README + usage.md (CHANGED)

`README.md` — wherever `--ui` is documented in the flag table, change the description from "foreground surface: tui (default) or repl" to "foreground surface: tui (default; recommended) or repl (deprecated — removal in M13)". Add a short paragraph below the table noting that `SOV_NO_DEPRECATION_WARNING=1` suppresses the warning for users who can't migrate yet.

`docs/usage.md` — similar treatment in whatever flag/section covers `--ui`.

## 5. Tests

**Unit (`tests/cli/replDeprecation.test.ts`, new):**
- `source='cli'` returns a message containing `'--ui repl'`.
- `source='env'` returns a message containing `'SOV_UI=repl'`.
- `source='config'` returns a message containing `'ui.surface=repl'`.
- `source='default'` returns `null` (defense against a future default flip).
- `SOV_NO_DEPRECATION_WARNING=1` returns `null` for all sources.
- Each non-null message contains the M13 reference and the suppression env-var name.

**Integration via boot smoke (extended):** the existing M11 boot-decision smoke harness (`docs/state/2026-05-17-m11-smoke/run-smoke.ts`) captures `--ui repl` / `SOV_UI=repl` / `ui.surface=repl` scenarios. M12 adds an extra assertion to each that the deprecation warning string appears on stderr; and at least one scenario with `SOV_NO_DEPRECATION_WARNING=1` asserts the warning is absent. Re-run captures the new transcripts to `docs/state/2026-05-19-m12-smoke/` for the close-out.

**Coverage matrix:**

| `--ui` | `SOV_UI` | `ui.surface` | Binary | Expected | Deprecation fires? |
|---|---|---|---|---|---|
| (unset) | (unset) | (unset) | present | TUI | no |
| (unset) | (unset) | (unset) | missing | REPL + missing-binary warning | no (fallback, not opt-in) |
| `--ui repl` | (unset) | (unset) | * | REPL | **yes** (source=cli) |
| (unset) | `SOV_UI=repl` | (unset) | * | REPL | **yes** (source=env) |
| (unset) | (unset) | `ui.surface=repl` | * | REPL | **yes** (source=config) |
| `--ui repl` | (unset) | (unset) | * + `SOV_NO_DEPRECATION_WARNING=1` | REPL | no (suppressed) |
| `--ui tui` | `SOV_UI=repl` | * | present | TUI (CLI wins) | no |

## 6. ADRs

### ADR M12-01 — Deprecation warning fires on explicit opt-in only; not on missing-binary fallback

**Decision:** The warning predicate is `resolution.surface === 'repl'`, NOT `effectiveSurface === 'repl'`. When the missing-binary fallback flips `effectiveSurface` from `'tui'` to `'repl'`, `resolution.surface` stays `'tui'` and the warning stays silent.

**Rationale:** Users hit the missing-binary fallback when they haven't trusted the postinstall (`bun pm -g trust @yevgetman/sov`) or don't have Go on PATH. They didn't choose REPL — they chose TUI (or the default), and the harness softly downgraded them. Warning them about REPL deprecation in addition to the existing "sov-tui binary not found" stderr line would be punitive and confusing ("I asked for the TUI, why are you telling me REPL is deprecated?"). The existing fallback warning already points at the remediation path.

**Alternatives rejected:**
- (a) Warn unconditionally when `effectiveSurface === 'repl'`. Rejected per above — penalizes the soft-degradation case.
- (b) Warn only on `source === 'cli'` (skip env + config). Rejected — env and config are explicit user choices too, just expressed via different surfaces. Persistent opt-ins should hear the deprecation just as loudly.
- (c) Print a separate "you can also try the TUI" hint inside the missing-binary fallback warning. Rejected — that's M11's wording, not M12's; bundling the M12 message into the M11 warning would conflate two independent concerns.

**Status:** to be implemented in M12.

### ADR M12-02 — Suppression via env var only; no config field

**Decision:** `SOV_NO_DEPRECATION_WARNING=1` suppresses the warning. There is no `ui.suppressDeprecationWarning` config field.

**Rationale:** This deprecation is temporary by design. M13 removes the REPL entirely, at which point the warning becomes moot. Building a config field would commit `ui.suppressDeprecationWarning` to the schema's API surface, and we'd then have to retire it when M13 ships — schema thrash for a one-milestone affordance. An env var is shell-local, easy to set per-invocation or in a shell rc, and doesn't claim namespace in `ui.*`.

The env-var name also makes the workaround discoverable in the warning text itself: users who see the message and don't want it can copy/paste the env-var name into their shell rc. No documentation hunt required.

**Alternatives rejected:**
- (a) `ui.suppressDeprecationWarning` config field. Rejected — schema thrash, see above.
- (b) No suppression at all. Rejected — power users / scripted CI / soak periods need an escape hatch. Without one, the warning becomes noise users learn to ignore, which devalues future warnings.
- (c) Per-session in-memory acknowledgement (warning shown once then never again). Rejected — overengineered; the warning is one stderr line, suppressing it after acknowledgement requires persistent state on disk that doesn't justify the complexity.

**Status:** to be implemented in M12.

## 7. Migration

This is a deprecation announcement, not a breaking change. The REPL keeps working bit-for-bit. M13 will be the breaking removal.

**User-facing impact:**
- Explicit-opt-in REPL users see one extra stderr line at boot.
- Users on default TUI or missing-binary-fallback see nothing new.
- Suppression is one env var away.

## 8. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Warning fires on the missing-binary fallback path | Low | Predicate is `resolution.surface === 'repl'`, not `effectiveSurface`. Smoke scenario for missing-binary-fallback asserts the warning is absent. |
| Warning suppresses something silently — user upgrades, forgets the env var, and never sees a real future warning | Low | The env-var name is specific to deprecation warnings; future critical warnings can use different channels (e.g., stderr without the suppression check). |
| Multiple deprecation warnings batch up (e.g., M14, M15) and the single env var silences all of them | Low | Acceptable trade-off for the M12→M13 window. If future deprecations need fine-grained suppression, refactor then. |
| Future shift back to default-REPL surfaces the warning on every boot | Very low | Helper short-circuits on `source === 'default'`. Belt-and-suspenders even though the M11 default is 'tui'. |
