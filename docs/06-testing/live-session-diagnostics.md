# Diagnose a live SOV turn without interrupting it

Observe the installed process and its own persisted trace. A newer source checkout or release does not establish the version running in a channel.

## Read-only evidence

1. Check the executable version with `sov --version`. Record the actual process path, provider/model/effort and session id from the host's state. Do not print credential arguments or environment variables.
2. Read the session trace under the process's trace home. `sov trace show <session-id>` reads the default trace home. A host may use a separate session database and trace home; resolve each independently.
3. Separate each user invocation at `session_start` / `session_end`. A reused session file contains several turns and gaps between user requests. Whole-file duration is not turn latency.
4. Compare `provider_request` and `provider_response`: first-token time, total response time, output tokens and cached versus uncached input. Match `tool_start`/`tool_end`/`tool_error` by tool id. Parallel tools can overlap, so their durations must not be added as a wall-time budget.
5. If session storage is needed, open SQLite with `mode=ro` and a short timeout. Use bounded queries. Preserve WAL semantics; do not use `immutable=1` on a live database. Never checkpoint, vacuum, edit state, send signals or restart the host to observe a turn.
6. Sample CPU/RSS and message/trace progress over a stated window. A wait on model output or a tool is not evidence of a deadlock. Sampled RSS is not a peak-memory or leak certificate.

## Failure interpretation

**Unreleased diagnostic correction:** AgentTool now includes a bounded, always-redacted terminal `errorMessage` in failed results and an escaped diagnostic in its rendering. Available partial summaries remain visible. An empty nominal success is still a failure and now says why.

The subscription executor retains available captured messages/tool counts after a nonzero exit or cancellation. The process failure overrides any completed marker in stdout. Failed captures are not replayed to learning. Capture remains a bounded stdout tail, not a complete external-effect ledger or a new retry guarantee. Before retrying, inspect the host's actual artifacts and external effects.

`tool_end.isError` records in-band failures. The trace viewer shows `error` for true, `ok` for false, and `finished` for older records that do not contain the flag. Legacy `tool_end` alone does not prove success. Thrown tools retain their `tool_error` event.

A child that reports zero turns/tools after failing is not proof of no execution. Compare its external executor transcript when available. Match the exact delegated prompt and timestamps privately; never copy consumer prompts, credentials, paths or raw logs into public examples.

## Performance choices

Use evidence before changing provider, effort or time budgets. Keep diagnostic output narrow, use task-specific tool pools, and batch related inspection operations when independent. Large repeated tool output increases the next model context even if caching reduces its price. A timeout must be scoped to the intended lane/host and workload; do not change machine-wide defaults for one channel.

Install/release fixes separately after validation. Keep an attended live session on its current executable until its lifecycle permits an update. A source PR does not hot-patch a running process.

## Read next

[Testing log](testing-log.md) · [Consumer contract](../05-conventions/consumer-contract.md) · [Host lifecycle](../04-extending/host-session-lifecycle.md)
