# Spec — `sov run --steer-file`: mid-turn steering injection

**Date:** 2026-07-09
**Status:** Green-lit (CEO direction 2026-07-09, via the telekit mid-turn-steering
spec `~/code/telekit/specs/2026-07-09-mid-turn-steering.md` §7.1 — "sov first: we
own the SDK"). Building now.
**Author:** Julie

## Goal

Let a machine adapter (telekit's Telegram bridge) inject an operator message into
a RUNNING `sov run` turn — the sov counterpart of the Claude harness's
PostToolUse/Stop-hook steering lane, giving the SOV lane true mid-turn steering
(`↪️` ack) instead of turn-end follow-ups (`⏸`).

## Contract

`sov run --json --stdin --steer-file <path>`:

- The steer file is **JSON-lines**, each line `{"text": "<message>"}` — the same
  format telekit's bridge already appends to its per-profile steer queue, so
  telekit passes its existing queue path verbatim.
- At each **agent-loop boundary** sov polls the file; if present+non-empty it is
  **consumed atomically** (rename → read → unlink; corrupt lines skipped) and the
  message(s) are injected into the turn:
  - **Tool boundary:** merged as an extra text block into the tool-result user
    message of the just-finished tool batch, pre-yield — the same mechanism the
    loop-detector guidance uses, which keeps Anthropic's role-alternation and
    tool_use→tool_result adjacency invariants intact and rides the existing
    persistence path (transcripts stay faithful; `--resume` reconstructs exact
    context).
  - **Turn end:** when the model produced a final answer (no tool calls), sov
    polls once more; pending steers become a standalone user message
    (assistant→user alternation is legal there) and the loop CONTINUES instead
    of finishing — same semantics as the claude Stop hook. `maxTurns` bounds it.
- Injected text is **framed by the injector** (untrusted-content markers +
  "mid-turn steering message from the operator's channel" preamble) — content
  and direction, never rule-overriding instructions.
- A `steer_injected` server event (`{type, seq, sessionId, count}`) is published
  when an injection happens, riding the JSONL stream additively (adapters that
  don't know the type ignore it).
- No `--steer-file` → zero behavior change. Missing/empty file → no-op polls
  (one `rename` attempt returning ENOENT per boundary).

## Design (layer by layer)

1. **SDK (`packages/sdk`)** — `QueryParams.pollSteering?: () => Promise<string | null>`
   (host thunk, mirrors `recall`), threaded through `createAgent`'s
   `AgentConfig`/`PerTurn` the same way. `query()` calls it (a) after each tool
   batch, merging the returned text into the batch's last user message pre-yield;
   (b) at the no-tool-use terminal point, pushing+yielding a standalone user
   message and continuing. The SDK knows nothing about files or framing — it
   receives ready-to-inject text or null.
2. **Server (`src/server`)** — `steer_injected` in the ServerEvent schema; a
   `steerFile` runtime option; `turns.ts` builds the `pollSteering` closure
   (atomic consume + frame + bus publish) and passes it per-turn.
3. **CLI** — `--steer-file <path>` on `sov run` (main.ts), `RunOptions.steerFile`
   → `buildOpts.steerFile` (runCommand.ts).

## Security

- The steer file is a caller-supplied path read/deleted as the invoking user —
  same trust class as `--db`/`--bundle`.
- Injected content always carries the untrusted-content framing; it can steer
  the work, not the rules.
- Steer text is never echoed to stderr/logs beyond the transcript itself.

## Testing

- `tests/core/query.test.ts` — pollSteering: tool-boundary merge (role
  invariants hold, text present in the yielded user message), turn-end
  continuation (loop runs another iteration, standalone user message yielded),
  null thunk → byte-identical behavior, maxTurns still bounds.
- `tests/cli/runCommand.steering.test.ts` — E2E through `runRunCommand` with
  `MockProvider.toolUseScript`: steer file planted before the tool batch is
  consumed → injected text visible in `MockProvider.lastMessages` and
  `steer_injected` on the JSONL stream; file consumed; absent file → stream
  identical to today.
- Full gates: `bun test`, `bun run lint` (incl. the open-core boundary),
  `bun run typecheck`.

## Out of scope

- TUI surface for steering (machine lane only).
- Multi-file/watch APIs; polling at loop boundaries is the contract.
