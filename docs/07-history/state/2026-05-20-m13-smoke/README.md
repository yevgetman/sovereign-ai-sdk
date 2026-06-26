# M13 Smoke — Boot-Decision Scenarios

**Date:** 2026-05-20
**HEAD:** `593d9156eaae516e4d3409cc383378b11a65fcbc` (M13 close-out)
**`sov --version`:** `0.1.0-593d915`
**Command target:** installed `sov` binary (refreshed via `sov upgrade` from a
stale `dd96f2d` install before running the smoke). All four scenarios exercise
the same global binary that end users get from `bun pm -g`.
**Task:** Phase 16.1 M13 T11 — verify post-removal boot decisions.

## Scenarios

| # | Scenario | Verdict | File |
|---|----------|---------|------|
| 1 | Default `sov` boots Go TUI | **PASS** | [`01-default-boot.txt`](./01-default-boot.txt) |
| 2 | `sov-tui` missing → hard error, exit 1 | **PASS** | [`02-missing-binary.txt`](./02-missing-binary.txt) |
| 3 | `--ui repl` → Commander rejects unknown option, exit 1 | **PASS** | [`03-unknown-flag.txt`](./03-unknown-flag.txt) |
| 4 | `sov dispatch` still works | **PASS** | [`04-dispatch.txt`](./04-dispatch.txt) |

**Overall: 4/4 PASS.**

## Method notes

- **Scenario 1** used `script(1)` to allocate a PTY so the Go TUI could open
  `/dev/tty` and emit its splash. Capture shows the HTTP server boot line
  (`sov: tui server listening on 127.0.0.1:<port> session=<uuid>`) followed by
  the unmistakable Bubble Tea init sequences: `ESC[?1049h` (alt-screen),
  `ESC[?25l` (cursor hide), `ESC[?1002h` + `ESC[?1006h` (mouse tracking),
  `ESC[?2004h` (bracketed paste). Process was killed after 2.5s
  (interactive); exit 143 (SIGTERM) is expected.
- **Scenario 2** required temporarily renaming the bundled binary at
  `~/.bun/install/global/node_modules/@yevgetman/sov/bin/sov-tui` to
  `sov-tui.hidden-smoke-test`. The PATH-stripping approach in the task brief
  doesn't apply here: `tuiLauncher.findTuiBinary()` does no `$PATH` lookup —
  it only checks `SOV_TUI_BIN` (must exist) and then walks up from the
  module's own install dir looking for `bin/sov-tui`. The bundled binary is
  always 1 level up from the installed module, so renaming was the only way
  to make the upward walk return `null`. Binary was restored immediately
  after the test (verified post-restore).
- **Scenario 3** exercises Commander's option-validation path. `--ui` was the
  removed flag in T1 of M13; rejection here confirms the removal landed in
  the installed binary.
- **Scenario 4** ran from `/tmp` to confirm `sov dispatch` doesn't accidentally
  require a bundle/project root. `/help` printed the full registry; `/quit`
  exited cleanly with code 0.

## Cross-check

- `findTuiBinary()` source: `src/cli/tuiLauncher.ts:34-60`
- Hard-error branch: `src/main.ts:204-208`
- `--ui` flag removal: confirmed by Commander error message
- Dispatch unchanged: `src/cli/dispatchCommand.ts` + `src/commands/registry.ts`
