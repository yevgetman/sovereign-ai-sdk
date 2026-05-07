# Bug: Loop Detector Second-Strike Leaves Orphaned `tool_use` Blocks in History

**Status:** ✅ Resolved (2026-05-07, commit `db1c5eb`)  
**Severity:** Medium-High  
**Affected file:** `src/core/query.ts`  
**Discovered:** 2026-05-07 via transcript `~/.harness/debug/transcript-2026-05-07T14-05-19-946Z.jsonl`  
**Fixed in:** `db1c5eb` — second-strike `else` branch now synthesizes `tool_result` blocks for any pending `tool_use`, pushes them to history, and yields the message before returning. Regression test added in `tests/loop/wiring.test.ts` (`second-strike abort yields synthetic tool_result for orphaned tool_use`).

---

## Summary

When the loop detector fires for the **second time** (the abort strike), it returns an error without
synthesizing `tool_result` blocks for any `tool_use` blocks already pushed to conversation history.
This leaves the history in a protocol-invalid state. Any subsequent API call — including the user
simply asking "what happened?" — is rejected by Anthropic with a 400 error, making the session
permanently unrecoverable.

---

## Root Cause

In `src/core/query.ts`, the assistant message (which may contain `tool_use` blocks) is pushed to
`history` at **line 186**, before loop detection runs at **line 190**. On the second detection
strike, the `else` branch at **~line 248** immediately returns with an error string — with no call
to `synthesizeToolResultMessage()`.

```
history.push(assistant)          // line 186 — tool_use now in history
toolUseBlocks = ...              // line 188 — extracted for dispatch
loopDetect()  → count becomes 2  // line 219
if (count === 1) { ... }         // line 240 — false on 2nd strike
else {
  return error(...)              // line 248-253 — NO synthetic tool_result ← BUG
}
```

Every other abort path in the same file handles this correctly:

| Abort path | Synthesizes tool_result? |
|---|---|
| `signal?.aborted` during dispatch (~line 360) | ✅ Yes |
| `max_tokens` stop reason (~line 268) | ✅ Yes |
| No tools provided (~line 289) | ✅ Yes |
| No `toolContext` (~line 301) | ✅ Yes |
| **Loop detector 2nd strike (~line 248)** | ❌ **No** |

---

## Reproduction

1. Run any task that triggers repetitive tool calls (e.g. a `for` loop in a Bash command combined
   with other tool use in the same turn).
2. The loop detector fires twice (`action-stagnation` heuristic).
3. The session returns the abort error to the UI.
4. Send any follow-up message.
5. Observe: Anthropic API returns `400 invalid_request_error` — `tool_use ids were found without
   tool_result blocks immediately after`.

From the transcript that surfaced this bug:
```
{"type":"provider_error","message":"aborted by loop detector after 2 detections (action-stagnation)"}
// user asks "what happened?"
{"type":"provider_error","message":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",
\"message\":\"messages.28: `tool_use` ids were found without `tool_result` blocks immediately after:
toolu_015Hoky6yJ4LPZU8XRPC9GPc. Each `tool_use` block must have a corresponding `tool_result` block
in the next message.\"}"}
```

---

## Impact

- Session becomes **permanently unrecoverable** after the loop abort — not just degraded.
- Affects any user who tries to interact after a loop-detector abort (the most natural thing to do).
- The fix exists and is low-risk; the infrastructure (`synthesizeToolResultMessage`) is already
  written and used in 4 other places in the same file.

---

## Fix (shipped in `db1c5eb`)

In the second-strike `else` branch, synthesize a `tool_result` message for any pending
`tool_use` blocks, push it to internal history, **and yield it** so the caller (REPL)
appends it to its persisted history and the session DB. Mirrors the `signal?.aborted`
dispatch path.

```typescript
} else {
  if (toolUseBlocks.length > 0) {
    const msg = synthesizeToolResultMessage(
      toolUseBlocks,
      'tool call interrupted by loop detector',
    );
    history.push(msg);
    yield msg;
  }
  await maybeFireStop('error');
  return {
    reason: 'error',
    error: new Error(
      `aborted by loop detector after ${loopDetectionCount} detections (${detection.detector})`,
    ),
  };
}
```

The `yield msg` step is load-bearing: without it, the synthetic `tool_result` lives only
in `query()`'s internal `history` (which is discarded on return). The REPL's
`turnMessages` and the session DB never see it, so the orphan re-appears on the next
provider call and on session resume.

---

## Notes

- The **first** loop detection strike (count === 1) injects a guidance message into the next
  `tool_result` user message (line ~241–245) and does not abort, so it is not affected.
- The `action-stagnation` heuristic (which fired here) triggers on 12 repeated tool names,
  excluding read-only tools. A `for` loop over `resume add` calls hit this threshold.
- Consider also whether the loop detector threshold for `action-stagnation` should be higher for
  legitimate bulk-write patterns, or whether the harness should recognize sequential shell loops
  as a single logical action rather than N separate ones.
