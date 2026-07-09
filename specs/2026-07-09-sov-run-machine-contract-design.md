# Spec - `sov run` machine contract

- **Date:** 2026-07-09
- **Author:** Julie (Gene's AI assistant)
- **Status:** CEO green-lit by Telegram directive: "commit the spec then proceed to implement #1"
- **Driver:** Apex umbrella spec `~/code/me/specs/2026-07-09-sov-machine-contract-and-telekit-adapter-spec.md`

## Summary

Add a new headless machine runner, `sov run --json --stdin`, for external harness adapters such as
Telekit. The command reads all stdin as one prompt, runs exactly one turn through the same
runtime/server path as the TUI/`drive`, and emits newline-delimited JSON events suitable for a
machine parser.

This is not a replacement for `sov drive`. `drive` stays the line-driven human/test transcript
surface. `run` is the stable adapter surface.

## Scope

In:

- New `run` subcommand.
- `--json` and `--stdin` flags; both required for the initial machine contract.
- All-stdin-as-one-turn prompt handling.
- Existing runtime options: `--bundle`, `--provider`, `--model`, `--max-tokens`,
  `--permission-mode`, `--resume`, `--db`, `--no-cache`, `--no-preflight`.
- Existing reasoning effort option: `--effort off|low|medium|high|max`.
- JSONL stdout:
  - `session.started`
  - server protocol events as parsed event objects
  - `turn.completed`
  - `turn.error`
- Structured final event with `sessionId`, `reply`, `finishReason`, and usage when available.
- Tests proving multiline stdin is one turn and session ids are emitted/resumable.

Out:

- Structured attachment envelope.
- Named permission profiles.
- Provider capability registry.
- Native xAI/Google lanes.
- Telekit integration.
- Any behavior change to `sov drive`.

## Contract

Command:

```sh
sov run --json --stdin [flags]
```

Output is JSONL on stdout. Stderr is diagnostics only.

Required events:

- `{"type":"session.started","sessionId":"...","resumed":false,"provider":"...","model":"..."}`
- direct server events such as `text_delta`, `thinking_delta`, `tool_result`, `turn_complete`,
  and `turn_error`
- `{"type":"turn.completed","sessionId":"...","reply":"...","finishReason":"...","usage":...}`
- `{"type":"turn.error","sessionId":"...","error":"...","recoverable":...}`

Exit:

- `0` on a completed turn.
- Nonzero on startup/input/preflight errors or turn errors.

## Acceptance

- `printf 'hello\nworld\n' | SOV_TEST_MOCK_PROVIDER=1 sov run --json --stdin --provider mock --no-preflight`
  produces one `session.started` and one `turn.completed`.
- The final reply is non-empty.
- The session id can be passed to `--resume`.
- `sov drive` tests/behavior remain unchanged.
