# Phase 16.1 M11 — Smoke transcripts

**Date:** 2026-05-17
**Spec:** [`../specs/2026-05-17-phase-16-1-m11-default-flip-design.md`](specs/2026-05-17-phase-16-1-m11-default-flip-design.md)
**Plan:** [`../plans/2026-05-17-phase-16-1-m11-default-flip.md`](plans/2026-05-17-phase-16-1-m11-default-flip.md)

This directory holds the M11 smoke output. Two surfaces are exercised:

1. **Local boot-path smoke** (`run-smoke.ts`) — Bun-driven subprocess
   smoke that spawns `bun src/main.ts` against 13 scenarios verifying
   the surface resolver, missing-binary fallback, env/config/CLI
   precedence, and help-text changes. Cost: $0.
2. **Real-Anthropic dispatcher smoke re-run** (`14-m10_5-dispatcher-real-api-rerun.transcript.txt`)
   — the M10.5 `tests/parity/m10_5SlashSmoke.test.ts` test re-run
   to confirm slash-command dispatcher commands still work end-to-end
   post-M11 flip (2 prompts × Haiku 4.5). Cost: ~$0.005.

## Smoke environment

The local-boot smoke runs `bun src/main.ts` as a subprocess against a
temporary `HARNESS_HOME` and `HARNESS_BUNDLE` per scenario, with
`stdin: 'ignore'` (no TTY) and `timeout: 6000ms`. Both REPL and TUI
surfaces exit early in this environment — the REPL because EOF on
stdin, the TUI because sov-tui can't open `/dev/tty`. The *boot
decision* (which surface gets reached) is what's verified, not the
interactive behavior, which is covered by the M10.5 dispatcher smoke
+ M10 real-Anthropic soak transcripts.

## Scenario results

| # | Scenario | Expected surface | Result | Notes |
|---|---|---|---|---|
| 01 | bare `sov` (no flags, no env, no config) | TUI | ✓ TUI started (`sov: tui server listening on …`) | M11 default works |
| 02 | bare `sov` with `bin/sov-tui` hidden | REPL via fallback | ✓ Warning + REPL banner | "sov: sov-tui binary not found — falling back to readline REPL." |
| 03 | `SOV_UI=repl sov` (no CLI, no config) | REPL via env | ✓ REPL banner, exit 0 | env wins over default |
| 04 | `sov --ui repl` | REPL via CLI | ✓ REPL banner, exit 0 | CLI wins |
| 05 | `sov --ui tui` (explicit) | TUI | ✓ TUI started | CLI explicit |
| 06 | config `ui.surface=repl` only | REPL via config | ✓ REPL banner, exit 0 | config wins when CLI + env absent |
| 07 | `sov --ui tui` + config `ui.surface=repl` | TUI (CLI wins over config) | ✓ TUI started | CLI > config |
| 08 | `SOV_UI=tui sov` + config `ui.surface=repl` | TUI (env wins over config) | ✓ TUI started | env > config |
| 09 | `sov --ui xyzzy` (invalid CLI) | TUI via default + warning | ✓ Warning printed + TUI started | "sov: unknown --ui value 'xyzzy' (expected 'tui' or 'repl'); falling back to env/config." |
| 10 | `SOV_UI=nonsense sov` (invalid env) | TUI via default, no warning | ✓ TUI started, no stderr warning | env typos are silent by design |
| 11 | `sov --help` | help output | ✓ Commands overview | top-level help |
| 12 | `sov --version` | version string | ✓ `0.1.0-<sha>` | git-SHA-suffixed version (backlog #37) |
| 13 | `sov chat --help` | help output incl. `--ui` text | ✓ `--ui <surface> foreground surface: tui (default) or repl` | new help text confirmed |
| 14 | M10.5 dispatcher real-API rerun (`SOV_M10_5_REAL_SMOKE=1`) | 2 pass | ✓ 2 pass / 0 fail / 5 expect() in 3.73s | `/help` via dispatcher + slash+turn coexist; both work post-M11 |

**All 14 scenarios pass.**

## Cost

- Scenarios 01–13: $0 (no API calls).
- Scenario 14 (M10.5 dispatcher rerun): ~$0.005 (2 short Haiku 4.5 interactions, per M10.5 documentation).
- **Total: ~$0.005.**

## How to reproduce

```bash
# From the repo root:
bun docs/07-history/state/2026-05-17-m11-smoke/run-smoke.ts

# Optional: real-API dispatcher re-verification (Haiku 4.5):
SOV_M10_5_REAL_SMOKE=1 bun test tests/parity/m10_5SlashSmoke.test.ts
```

## Adaptations from the original spec

The spec called for a single interactive Haiku 4.5 session running
~10 dispatcher commands inside the TUI. The autonomous-execution
environment cannot drive an interactive TUI through arbitrary
keystrokes, so the adaptation is:

- **Boot decision verified end-to-end** via the local-boot smoke (13
  scenarios, all 5 precedence layers exercised).
- **Dispatcher command behavior verified** via the existing M10.5
  real-Anthropic smoke (re-run as scenario 14). The M10.5 test
  exercises `/help` and a model turn coexisting in the same session
  against the live Anthropic API — these are the same code paths
  the TUI uses for slash dispatch post-M11.
- **Missing-binary fallback exercised in production-equivalent
  conditions** by moving the working tree's `bin/sov-tui` aside for
  scenario 02 (restored after the scenario completes).

The deferred backlog items #41 (`createClearedChildSession`), #43
(`createDefaultMemoryManager`), #44 (`appendProjectLocalPermissionRule`)
remain MEDIUM-severity informative-output stubs in the TUI per ADR
M10-04 — their behavior is unchanged in M11 and is not re-verified here.
