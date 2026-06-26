# Phase 16.1 M11 — Default-flip design (`--ui tui` becomes the default)

**Date:** 2026-05-17
**Author:** autonomous brainstorm session
**Status:** approved, autonomous execution authorized
**Predecessor:** [M10.5 close-out snapshot](docs/07-history/state/2026-05-16-m10-5.md) — slash dispatcher shipped; backlog #40 closed; **M11 unblocked**.

## 1. Goal

Flip the foreground-surface default. Today, bare `sov` runs the readline-based `src/ui/terminalRepl.ts`. After M11, bare `sov` boots the Go Bubble Tea TUI (via `--ui tui` → `runTuiLauncher`). Users who prefer the REPL can still get it via `--ui repl`, the env var `SOV_UI=repl`, or the persistent config field `ui.surface=repl`.

## 2. Non-goals (in-scope-for-later-milestones)

- **M12 — terminalRepl deprecation.** Deprecation warning when `--ui repl` is used. Not in M11.
- **M13 — terminalRepl removal.** Deletion of `src/ui/terminalRepl.ts` + the readline helpers it imports. Strictly after M12's deprecation period.
- **Backlog #41, #43, #44 (P2/P3).** `createClearedChildSession` / `createDefaultMemoryManager` / `appendProjectLocalPermissionRule` server wiring. These remain MEDIUM-severity deferred items from the M10 audit; `/clear`, `/rollback`, `/memory`, project-scoped persistence still emit informative-output messages in the TUI per M10.5 ADR M10-04. M11 does not block on them — the M10 audit already classified them as MEDIUM (non-blocking).

## 3. Decisions (locked by brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Auto-fallback to REPL with stderr warning** when `sov-tui` binary missing | Preserves the soft-degradation safety net users have today. Hard-failing on bare `sov` for fresh installs without `bun pm -g trust @yevgetman/sov` would be a bad first impression. Warning makes the missing-binary situation discoverable. |
| D2 | **Config field `ui.surface: 'tui' \| 'repl'`** in `~/.harness/config.json`. Resolution order: CLI flag > env `SOV_UI` > config `ui.surface` > `'tui'` default | Matches existing config patterns (theme, profiles). Recoverable via `sov config unset ui.surface`. Three escape hatches keeps Postmortem Rule 4's spirit intact even after the default flips. |
| D3 | **Focused parity re-audit** (1 Opus subagent) verifying M10 gaps closed + delta since M10 | M10 already did the heavy 4-agent audit. The bulk of parity hasn't changed since M10; only M10.5 (dispatcher route) and M11 (the flip itself) are new. A focused re-audit catches drift without re-running M10's full methodology. Postmortem Rule 3 satisfied by "audit by reading the code, not recall." |
| D4 | **Comprehensive real-Anthropic smoke** — bare-sov boot + ~10 dispatcher commands + missing-binary fallback + config opt-out path | M11 is the user-facing flip moment. A 2-prompt sanity check would not adequately verify the surface change. ~$0.10 budget is well under any ceiling. |
| D5 | **No deprecation messaging on `--ui repl`** | Strict M11 scope. M12 will add a deprecation warning; M13 will remove. Keeping each milestone narrow makes any revert simpler. |

## 4. Architecture

### 4.1 Surface resolver

New module: `src/cli/surfaceResolver.ts` (~50 LoC).

```ts
import type { Settings } from '../config/schema.js';

export type Surface = 'tui' | 'repl';

export interface SurfaceResolution {
  readonly surface: Surface;
  readonly source: 'cli' | 'env' | 'config' | 'default';
}

export interface SurfaceResolverInput {
  readonly cliFlag?: string;          // opts.ui from Commander; may be undefined or arbitrary string
  readonly env?: NodeJS.ProcessEnv;   // for SOV_UI lookup; defaults to process.env
  readonly config?: Settings;         // for ui.surface lookup; defaults to readConfig()
}

export function resolveSurface(input: SurfaceResolverInput): SurfaceResolution;
```

Behavior:
- If `cliFlag` is `'tui'` or `'repl'` → `{ surface: cliFlag, source: 'cli' }`.
- Else if `env.SOV_UI` is `'tui'` or `'repl'` → `{ surface: ..., source: 'env' }`.
- Else if `config.ui?.surface` is `'tui'` or `'repl'` → `{ surface: ..., source: 'config' }`.
- Else → `{ surface: 'tui', source: 'default' }`.

Any other value (invalid CLI flag, invalid env, malformed config) falls through to the next layer. Invalid CLI flag also prints a one-line stderr warning so users notice typos.

The `source` field is for the smoke + future debug logging — it's NOT user-visible during normal operation.

### 4.2 Config schema

Add `ui: { surface?: 'tui' | 'repl' }` to the Settings Zod schema (already-existing in `src/config/schema.ts` — verify path during impl). Schema permits a missing `ui` object and a missing `surface` field; both fall through to the env/default chain.

`sov config set ui.surface repl` already works through the existing `setAt` dot-path helper. `sov config unset ui.surface` removes it.

### 4.3 main.ts dispatch

Today (`src/main.ts:182`):
```ts
.option('--ui <surface>', 'foreground surface: repl (default) or tui', 'repl')
```

After M11:
```ts
.option('--ui <surface>', 'foreground surface: tui (default) or repl', undefined)
```

The default is now `undefined`, not `'tui'`, so the resolver sees `cliFlag === undefined` and can fall through to env/config.

In the `.action(async (opts) => { ... })` handler, replace the current `if (opts.ui === 'tui') { runTuiLauncher } else { runRepl }` branch with:

```ts
const resolution = resolveSurface({
  cliFlag: opts.ui,
  env: process.env,
  config: readConfig(),
});

let effectiveSurface = resolution.surface;

if (effectiveSurface === 'tui') {
  const { findTuiBinary } = await import('./cli/tuiLauncher.js');
  if (findTuiBinary() === null) {
    process.stderr.write(
      'sov: sov-tui binary not found — falling back to readline REPL.\n',
    );
    process.stderr.write(
      '     to enable the TUI, run `bun pm -g trust @yevgetman/sov && sov upgrade`.\n',
    );
    effectiveSurface = 'repl';
  }
}

if (effectiveSurface === 'tui') {
  const { runTuiLauncher } = await import('./cli/tuiLauncher.js');
  const code = await runTuiLauncher(opts);
  process.exit(code);
}

// REPL path unchanged from today
const bundlePath = resolveBundlePath(opts.bundle);
const { runRepl } = await import('./ui/terminalRepl.js');
await runRepl({ /* unchanged */ });
```

`findTuiBinary` is already exported from `src/cli/tuiLauncher.ts` — verify the existing export shape during impl. If it's currently un-exported, expose it.

### 4.4 Help-text update

Change `--ui` description from `'foreground surface: repl (default) or tui'` to `'foreground surface: tui (default) or repl'`. Help text in `sov --help` updates automatically via Commander.

## 5. Verification

### 5.1 Unit tests

- **New** `tests/cli/surfaceResolver.test.ts` — precedence table covering:
  - cli > env > config > default
  - invalid CLI flag prints stderr warning + falls through
  - invalid env value falls through silently (env is unfriendly to typos by convention)
  - invalid config value falls through silently
  - 'tui' default when nothing is set
  - both 'tui' and 'repl' resolve through each layer
- **New or extended** config-schema test for `ui.surface` Zod parsing (locate during impl — likely `tests/config/schema.test.ts` or similar; add to existing if found, create new otherwise).
- **Update** any existing tests that assert `--ui` default is `'repl'` (likely none in current suite — grep during impl).

Suite target: all green, including the new tests. No regressions in the 2018-test baseline.

### 5.2 Parity re-audit

One Opus subagent. Brief:
- Read the M10 parity audit report (`docs/07-history/state/2026-05-16-tui-parity-audit.md`).
- Read M10.5's close-out (`docs/07-history/state/2026-05-16-m10-5.md`) + the dispatcher commits (`17d456b`, `d515b9f`).
- Read the M11 implementation diff (commits ahead of M10.5 close-out at HEAD).
- For each HIGH gap in the M10 audit: verify whether M10.5 + M11 close it. Categorize each.
- For new code in the M10.5 + M11 commit range: do a fresh import-scan to find any new wiring gaps.
- Severity-classify findings. CRITICAL/HIGH block close-out; MEDIUM/LOW → backlog.

Output: `docs/07-history/state/2026-05-17-m11-parity-audit.md`.

### 5.3 Real-Anthropic smoke

Single Haiku 4.5 session. Steps:
1. `sov upgrade` to install M11 binary.
2. Bare `sov` boots — verify Bubble Tea TUI launches (not REPL).
3. Inside the TUI, run in sequence: `/help`, `/cost`, one real model turn ("What is 2+2?"), `/cost` again, `/model claude-haiku-4-5-20251001`, `/tasks`, `/status`, `/agents`, `/permissions`, `/compact` (dedicated route), `/skills list`, `/theme dark`, `/clear` (verify informative #41 message), then `/quit`.
4. Exit TUI. Move `~/.bun/install/global/node_modules/@yevgetman/sov/bin/sov-tui` aside (or wherever `findTuiBinary` locates it). Run bare `sov` — verify stderr warning prints AND REPL boots. Inside REPL, run `/help` to confirm REPL works. `/quit`.
5. Restore `sov-tui` binary.
6. `sov config set ui.surface repl`. Run bare `sov` — verify REPL boots (no TUI). `/quit`. `sov config unset ui.surface`. Run bare `sov` — verify TUI boots again. `/quit`.
7. `sov --ui repl` — verify REPL boots (CLI flag wins).
8. `SOV_UI=repl sov` — verify REPL boots (env wins over default; CLI absent).

Capture stdout + stderr to `docs/07-history/state/2026-05-17-m11-smoke/`. Sanitize keys.

### 5.4 Pre-commit gate

`bun run lint && bun run typecheck && bun run test` — must be green. `cd packages/tui && go test ./... && cd -` — must be green (no Go changes expected in M11, but verify).

## 6. Postmortem-rule compliance

- **Rule 1 — `src/ui/terminalRepl.ts` untouched.** M11 does not edit terminalRepl. Verify via `git diff master -- src/ui/terminalRepl.ts` returns empty.
- **Rule 2 — no helper module deletion.** M11 does not delete anything. Verify via `git diff master --diff-filter=D -- src/` returns empty.
- **Rule 3 — audit before phase complete.** §5.2 satisfies this. M11's close-out commit lands after the audit signs off.
- **Rule 4 — flag-based safety net.** Three escape hatches survive the flip: CLI `--ui repl`, env `SOV_UI=repl`, config `ui.surface=repl`. PLUS the missing-binary auto-fallback preserves graceful degradation for users without the Go binary. Postmortem Rule 4 is honored by ensuring no user is forced into the new surface with no out.

## 7. Documentation updates

- **`README.md`** — update the `--ui <repl|tui>` flag description in the quick-usage section. Update any other references to "default `repl`."
- **`docs/03-cli-reference/usage.md`** — update flag description there too.
- **`CLAUDE.md`** + **`AGENTS.md`** — update the state-pointer line to reference `docs/07-history/state/2026-05-17-m11.md`. Verify byte-identical mirror.
- **`docs/07-history/state/2026-05-17-m11.md`** — new close-out snapshot following the M10.5 template structure.
- **`docs/08-roadmap/backlog/post-phase-13-4.md`** — update the sync header line; add any new items uncovered during audit (likely none if audit is clean).
- **`DECISIONS.md`** — ADRs M11-01..N covering: the flip itself, the resolver precedence, the missing-binary fallback policy.

## 8. Commit chain (atomic per CLAUDE.md)

1. **`feat(config): add ui.surface schema field`** — Zod field + unit test
2. **`feat(cli): add surface resolver with cli/env/config precedence`** — `src/cli/surfaceResolver.ts` + tests
3. **`feat(cli): M11 — flip --ui default to tui + missing-binary fallback`** — `src/main.ts` flip + fallback wiring + help text + any existing-test updates
4. **`docs: M11 — update README + usage.md for default-flip`** — README + `docs/03-cli-reference/usage.md`
5. **`docs: M11 close-out — parity audit, smoke, state snapshot, ADRs`** — audit report, smoke transcripts, `docs/07-history/state/2026-05-17-m11.md`, ADRs M11-01..N, backlog updates, CLAUDE.md/AGENTS.md pointer

After commit 5: pre-commit gate (`bun run lint && bun run typecheck && bun run test`), `sov upgrade`, `git push origin master`.

## 9. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fresh-install user without `sov-tui` binary hits a hard failure | Medium without fallback; **NIL with fallback** | High (bad first impression) | D1 auto-fallback wired in §4.3 |
| User has aliased `sov` to expect REPL behavior | Medium | Low (they can pass `--ui repl` or set config) | Three escape hatches; warning when fallback fires |
| Regression in TUI surface surfaces post-flip | Low (M10 audit + M10.5 + this audit are 3 layers) | Medium (users hit it; revert M11 via `sov config set ui.surface repl` or wait for fix) | Audit + smoke catch most; config opt-out gives immediate user-side workaround |
| TUI binary present but broken (Go runtime mismatch, ABI drift) | Very low | Medium | Out of M11's scope — would surface as a TUI runtime error, user can fall back via `--ui repl` |
| New dispatcher route gap surfaces during smoke | Low (M10.5's 13 server-side tests + 7 Go-side tests cover the route) | Medium | If found, fix inline as a bug per autonomous-execution authority; otherwise file as backlog item |

## 10. Effort estimate

Per [`docs/05-conventions/estimation.md`](docs/05-conventions/estimation.md): sessions / dispatches / wall-minutes, never weeks.

- T1–T3 (config + resolver + main.ts flip + tests): ~1 implementation dispatch
- T4 (doc updates): inline, ~10 wall-minutes
- T5 (audit subagent): ~1 dispatch
- T6 (smoke): ~30 wall-minutes including the moving-binary-aside and config-unset sequences
- T7 (close-out): inline, ~30 wall-minutes

**Total: ~2 subagent dispatches + ~1.5 wall-hours inline work.** Real-Anthropic smoke cost: ~$0.10 (under any ceiling).
