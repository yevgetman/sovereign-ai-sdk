# Phase 16.1 M11 — Default-flip implementation plan

**Spec:** [`docs/specs/2026-05-17-phase-16-1-m11-default-flip-design.md`](../specs/2026-05-17-phase-16-1-m11-default-flip-design.md)
**Mode:** Fully autonomous (user authorized).
**Predecessor HEAD:** `d2de19b` (M10.5 close-out).

## Tasks (ordered)

### T1 — Config schema: add `ui.surface` field

**File:** `src/config/schema.ts`
**Change:** Inside `UiSchema` (line 57), add a `surface` field:
```ts
/** M11 — persistent foreground-surface preference. Resolved at
 *  `sov` boot via the precedence: CLI --ui flag > env SOV_UI >
 *  this field > 'tui' default. Recoverable via
 *  `sov config unset ui.surface`. */
surface: z.enum(['tui', 'repl']).optional(),
```

**Tests:** Extend `tests/config/schema.test.ts` with two cases:
- `ui.surface: 'tui'` parses cleanly.
- `ui.surface: 'invalid'` rejects via Zod.

**Commit:** `feat(config): add ui.surface schema field for M11 default-flip`

### T2 — Surface resolver module

**Files:**
- `src/cli/surfaceResolver.ts` (new, ~70 LoC including JSDoc)
- `tests/cli/surfaceResolver.test.ts` (new, ~150 LoC)

**Module shape** per spec §4.1. Behavior:
- CLI flag accepted only when exactly `'tui'` or `'repl'`. Other non-undefined strings → one-line stderr warning (`sov: unknown --ui value '<x>' (expected 'tui' or 'repl'); falling back to env/config`), then fall through.
- env `SOV_UI` accepted when exactly `'tui'` or `'repl'`. Invalid → silent fallthrough (env typos shouldn't spam stderr on every boot).
- config `ui.surface` accepted when set. Zod has already validated; just read.
- Default: `'tui'`.

The resolver does NOT call `readConfig()` itself — the caller passes the config object. This keeps it pure / testable without filesystem touches. `tests/cli/surfaceResolver.test.ts` exercises the precedence table with fixture Settings objects.

`process.stderr.write` for the invalid-CLI warning is injectable via an optional `stderr?: (s: string) => void` param on `SurfaceResolverInput` so tests assert the warning without polluting stderr.

**Test cases:**
- CLI 'tui' wins over env+config+default
- CLI 'repl' wins over env+config+default
- Invalid CLI ('foo') → warning + falls through; env='repl' wins
- Invalid CLI + nothing else → 'tui' default
- env 'tui' wins when CLI absent, config absent
- env 'repl' wins when CLI absent, config absent
- env 'tui' wins over config 'repl' when CLI absent
- Invalid env ('bar') + config='repl' → config wins, no warning
- Config 'tui' when CLI + env absent
- Config 'repl' when CLI + env absent
- Default 'tui' when all absent
- Source is reported correctly for each path

**Commit:** `feat(cli): add surface resolver with cli/env/config precedence`

### T3 — main.ts flip + missing-binary fallback

**File:** `src/main.ts`

**Changes:**

1. Line 182: change the `--ui` option from
   ```ts
   .option('--ui <surface>', 'foreground surface: repl (default) or tui', 'repl')
   ```
   to
   ```ts
   .option('--ui <surface>', 'foreground surface: tui (default) or repl')
   ```
   (No default — resolver handles fallthrough.)

2. In the `.action(async (opts) => { ... })` handler (line 199+), replace the deprecation-notice block + the `if (opts.ui === 'tui') { ... } / runRepl({ ... })` block with the resolver + fallback wiring per spec §4.3.

3. Add the imports near the top:
   ```ts
   import { resolveSurface } from './cli/surfaceResolver.js';
   import { readConfig } from './config/loader.js'; // confirm path during impl
   ```
   (or use existing `readConfig` import if already in main.ts).

4. The fallback warning text per spec:
   ```
   sov: sov-tui binary not found — falling back to readline REPL.
        to enable the TUI, run `bun pm -g trust @yevgetman/sov && sov upgrade`.
   ```

5. Update tests if any exist asserting `--ui` default is `'repl'`. (Grep confirmed none — but re-verify during impl.) Check the deprecation-notice block — `if (process.argv[2] === 'chat')` — for relevance under the new dispatch. Keep it; it's about `sov chat` deprecation, not `--ui` semantics.

**Commit:** `feat(cli): M11 — flip --ui default to tui + missing-binary fallback`

### T4 — Docs: README + usage.md

**Files:**
- `README.md` — search for `--ui` references and `repl (default)`. Update to reflect tui-default.
- `docs/usage.md` — same. Likely line in flag table.

Also check `src/main.ts:200-206` deprecation notice block — no change needed but verify the user-facing semantics align with new defaults.

**Commit:** `docs: M11 — update README + usage.md for default-flip`

### T5 — Parity re-audit subagent

Dispatch one Opus subagent (model: opus, never haiku). Brief:

> Read the M10 parity audit (`docs/state/2026-05-16-tui-parity-audit.md`), the M10.5 close-out (`docs/state/2026-05-16-m10-5.md`), and the M11 diff (commits ahead of `d2de19b`). For each HIGH and MEDIUM gap classified in the M10 audit, verify whether M10.5's slash-command dispatcher route (`src/server/routes/commands.ts` + `src/server/commandContext.ts`) and the M11 default-flip work close it. For each commit since `d2de19b`, do a fresh import-scan to find any new wiring gaps. Severity-classify findings (CRITICAL/HIGH/MEDIUM/LOW). Write the report to `docs/state/2026-05-17-m11-parity-audit.md`. CRITICAL/HIGH findings block M11 close-out; MEDIUM/LOW go to backlog. Use only Read/Bash/Grep — no edits.

**No commit yet** — the audit report is written but committed in T8 with the close-out.

### T6 — Real-Anthropic smoke

Single Haiku 4.5 session per spec §5.3. Capture stdout + stderr to `docs/state/2026-05-17-m11-smoke/` with one subdirectory per scenario:
- `01-bare-sov-boots-tui/`
- `02-dispatcher-commands/` (all in one session inside the TUI)
- `03-missing-binary-fallback/`
- `04-config-opt-out/`
- `05-env-precedence/`
- `06-cli-flag-precedence/`

Sanitize API keys. Cost cap: ~$0.20.

**No commit yet** — captured in T8 with close-out.

### T7 — Pre-commit gate after audit + smoke pass

Run before committing close-out:
- `bun run lint`
- `bun run typecheck`
- `bun run test` (full suite — target 2018+ passing including new tests; no regressions)
- `cd packages/tui && go test ./... && cd -` (sanity — no Go changes in M11)

If any failures, fix inline (autonomous bug-resolution authority per user mandate).

### T8 — Close-out commit

**Files:**
- `docs/state/2026-05-17-m11.md` — new close-out snapshot following the M10.5 template
- `docs/state/2026-05-17-m11-parity-audit.md` — audit report from T5
- `docs/state/2026-05-17-m11-smoke/**` — smoke transcripts from T6
- `DECISIONS.md` — ADRs M11-01..N covering:
  - M11-01: foreground-surface default-flip mechanics (CLI > env > config > default precedence)
  - M11-02: missing-binary auto-fallback policy
  - M11-03: scope discipline (no terminalRepl deprecation in M11 — that's M12)
- `docs/backlog/post-phase-13-4.md` — update the sync header to "2026-05-17 — M11 close-out" with list of still-open items; archive M10/M10.5 markers
- `CLAUDE.md` — update the state-pointer line(s) in the session-boot section + standing rules table to reference `docs/state/2026-05-17-m11.md`
- `AGENTS.md` — same change; verify byte-identical mirror via `diff CLAUDE.md AGENTS.md` (must return empty)
- `README.md` if not already updated in T4 — ensure the "Latest snapshot" line references the new state file

**Commit:** `docs: M11 close-out — default-flip shipped, parity re-audit, smoke, ADRs M11-01..03, state snapshot`

### T9 — sov upgrade + push

```bash
sov upgrade
```
to install the new binary globally so the user sees M11 behavior on the next `sov` invocation.

Then:
```bash
git push origin master
```

## Execution rules

- Atomic commits per CLAUDE.md convention. T1, T2, T3, T4, T8 each get their own commit. T5 + T6 contribute artifacts but ride in T8.
- No deletion of any code under `src/` (Rule 2).
- No edits to `src/ui/terminalRepl.ts` (Rule 1).
- Subagent model policy: Opus 4.7 only for the audit (T5). Implementation (T1-T3) is straightforward enough to do directly in the main session — no subagent. T4 + T8 are doc work, direct.
- Autonomous decision authority for: implementation choices within spec scope, test additions, bug fixes uncovered during work, doc-tone updates. Re-engage user only if a new HIGH gap surfaces in the audit that materially changes M11's shape.

## Estimated effort

- T1-T3: ~30 wall-minutes direct
- T4: ~10 wall-minutes
- T5: ~1 Opus subagent dispatch
- T6: ~20 wall-minutes (real-Anthropic prompts are slow per turn)
- T7: ~5 wall-minutes (suite runs)
- T8: ~30 wall-minutes
- T9: ~5 wall-minutes

**Total: ~2 wall-hours + 1 Opus dispatch.** Smoke cost: ~$0.10–0.20.
