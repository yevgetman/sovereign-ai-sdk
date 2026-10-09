# SOV auth routing — progress for the Telekit coordinator

**Updated:** 2026-10-08 (start). **Branch:** `feat/sov-auth-routing` in
`/Users/julie/code/sovereign-ai-sdk-auth-routing` (worktree of `sovereign-ai-sdk`).
**Contractor:** ctr_e49d95c67c96. Mirror copy: `/Users/julie/code/sovereign-ai-docs/.worktrees/ctr_e49d95c67c96/handoffs/`.

## Status

| Task | State |
|---|---|
| T1 routes, xai provider, status, cross-process lock | in progress |
| T2 shared host composition | in progress |
| T3 provider protocol audit (ChatGPT/Grok, images, effort) | in progress |
| T4 `sov run --sdk` host | not started |
| T5 docs, gate, PR | not started |

## Contract as planned (spec §5) — changes are listed under "Contract changes"

- `sov capabilities --json`, `sov routes --json`, `sov auth status --route <id> --json`.
  Each prints one JSON object with `schemaVersion: 1` on stdout. Diagnostics go to stderr.
- `sov run --sdk --route <id> --json --stdin --input-format json --db <path> [--resume <id>]
  [--model m] [--effort e] [--toolset chat|web|ops|coding] [--permission-mode m] [--steer-file p]`.
- Stdin envelope: `{"inputVersion":1,"text":"…","instructions":"…","images":[{"path":"/abs.png","mediaType":"image/png"}]}`.
  Unknown fields are rejected.
- JSONL: `session.started` (adds `route`, `auth`, `toolset`), existing server events
  (`text_delta`, `thinking_delta`, `tool_use_start`, `tool_result`, …), then exactly one
  `turn.completed` or `turn.error` (adds `code`).
- Exit codes: 0 completed, 1 turn failure, 2 invalid input/usage, 130 SIGINT, 143 SIGTERM.

## Contract changes

None yet.

## Remaining / unresolved

To be filled as tasks land.
