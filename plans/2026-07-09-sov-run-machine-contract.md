# Plan - `sov run` machine contract

Spec: `specs/2026-07-09-sov-run-machine-contract-design.md`.
Gate: `bun run lint && bun run typecheck && bun run test`.

## T1 - CLI surface

Add `sov run` to `src/main.ts` with required `--json` and `--stdin` flags plus the same runtime
options used by `drive`, and add `--effort`.

## T2 - Runner implementation

Add `src/cli/runCommand.ts`.

Implementation shape:

- Build runtime with the same option threading as `drive`.
- Create or resume a session.
- Emit `session.started`.
- Read all stdin as one prompt.
- Open/follow the event stream or reuse server event parsing.
- POST one turn.
- Emit parsed server events as JSONL.
- Accumulate text deltas for final `turn.completed.reply`.
- Emit `turn.completed` or `turn.error`.
- Stop server and dispose runtime before exit.

## T3 - Tests

Add focused tests for:

- multiline stdin as one turn;
- fresh session event;
- final completed event;
- resume flag;
- structured input errors;
- CLI arg validation if practical.

## T4 - Docs/log

Update CLI usage docs and testing log.

## T5 - Gate and commit

Run lint, typecheck, and tests. Commit the feature locally. Do not push from this Telegram run
without explicit confirmation.
