# M12 — REPL deprecation warning smoke (2026-05-19)

Captured by `bun docs/state/2026-05-19-m12-smoke/run-smoke.ts`. Focused on the M12 predicate (ADR M12-01): the deprecation warning fires when the user explicitly opted into REPL via `--ui repl` / `SOV_UI=repl` / `ui.surface=repl`, but stays silent on missing-binary fallback or default-TUI.

## Scenarios

| # | Scenario | Surface source | Expected deprecation | Result |
|---|---|---|---|---|
| 01 | `--ui repl` | CLI | **present** | PASS |
| 02 | `SOV_UI=repl` | env | **present** | PASS |
| 03 | `ui.surface=repl` (config) | config | **present** | PASS |
| 04 | `--ui repl` + `SOV_NO_DEPRECATION_WARNING=1` | CLI + suppression | **absent** | PASS |
| 05 | Bare `sov` with `sov-tui` binary hidden (missing-binary fallback) | default-TUI → REPL fallback | **absent** | PASS |
| 06 | Bare `sov` (default TUI, normal boot) | default | **absent** | PASS |

**Outcome: 6/6 PASS.** The predicate correctly distinguishes explicit user opt-in from system-driven soft-degradation. Suppression works as documented.

## Cost

$0 — no real-Anthropic calls. Each scenario boots `bun src/main.ts` against a clean `HARNESS_HOME` tmpdir and exits within the 6-second per-scenario timeout. Total wall-time: ~5–10s.

## Notes on scenario 06

Scenario 06 (bare `sov`, default TUI) exits with code 1 in the smoke harness because `Bun.spawn(... stdin: 'ignore')` simulates a non-interactive shell and the TUI launcher bails when it can't attach to a real TTY. The exit code isn't part of the M12 contract — the deprecation-absence assertion is what matters here, and it passes.

## Transcripts

One file per scenario with the prefix `<NN>-<name>.transcript.txt`. Each contains:
- Header: env, args, config.json content, expected deprecation
- stdout + stderr
- Footer: exit code, observed deprecation state, PASS/FAIL marker
