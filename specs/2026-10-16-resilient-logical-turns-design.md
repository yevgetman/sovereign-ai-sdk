# SOV resilient logical turns and Telekit recovery

Date: 2026-10-16

Status: Approved by the Owner in Telegram with: “load the dev skill set and proceed with implementation”.

Owners: Sovereign AI owns SOV and the SDK. Telekit owns the bridge adapter.

Source: Restored handoff copy of the specification sent to the Owner in the prior Telegram turn. The bridge removed the sent outbox copy after delivery. This restoration preserves the approved decisions and acceptance criteria.

## 1. Decision

SOV owns a complete logical turn.

A model-loop limit is an internal segment boundary. It is not a normal reason to fail the user's turn.

SOV continues safe unfinished work inside the same logical turn. It keeps the same session, route, model, effort, toolset, permissions, working directory, and user request.

SOV stops only when:

1. It has a final answer.
2. The user must supply information or approve an action.
3. The user stops the turn.
4. A verified unsafe or non-recoverable state blocks work.
5. The logical deadline or total work limit is reached.
6. The runtime detects repeated work with no progress.

SOV reports cases 2, 4, 5, and 6 with a clear reply. It does not expose `max_turns` as a generic error.

Telekit remains a transport and harness adapter. It supports SOV's recovery protocol. It also provides a narrow compatibility repair for older SOV releases that return a recoverable `needs_continuation` terminal.

For SOV only, this replaces the pause-only and no-auto-resume statements in Telekit's 2026-10-12 final-reply completion design. Other harness rules do not change.

## 2. Evidence

The failing Owner test used SOV 0.6.82 and the `ops` toolset.

- Jev correctly selected `ops`.
- The selected authentication route stayed correct.
- The catalog had 33 visible skills.
- `skills_list` returned 3 to 5 entries per request because of its context budget, even with `limit: 50`.
- The model followed each cursor correctly.
- `ops` allowed 8 model turns.
- Eight successful tool calls reached 30 of 33 skills.
- SOV then ended with `max_turns` before the last page and final answer.
- SOV returned `turn.error`, `code: needs_continuation`, exit 3, `recoverable: true`, and `nextAction: resume`.
- Telekit treated this as a final failure and showed a generic warning.
- The trace used about 123,705 cumulative input tokens for this enumeration.

There was no tool, cursor, auth, or decision-model error.

The same class can occur with web pagination, task output, large reads, long tool workflows, output-token limits, context compaction, transient provider faults, and safe process recovery. Raising the `ops` limit alone is not the fix.

## 3. Required outcomes

- SOV finishes safe logical turns across internal loop boundaries.
- SOV never repeats a confirmed effectful tool action during recovery.
- SOV keeps route, model, effort, toolset, permissions, cwd, and the original request fixed.
- SOV keeps one logical-turn identity across all internal segments.
- SOV uses compact tool output when the task needs compact data.
- SOV stays bounded by time, total model calls, retries, and progress checks.
- SOV can recover a durable logical turn after a clean process restart.
- Telekit does not show a safe internal continuation as an error.
- Older SOV releases can complete a safe recoverable turn through a bounded Telekit bridge.
- The wire has one final terminal for one logical turn.

## 4. Non-goals

- No unbounded retry loop.
- No silent route, model, account, payment, or toolset fallback.
- No wider permissions during recovery.
- No automatic retry of an effect whose result is unknown.
- No change to Jev or the four toolset labels.
- No generic Telekit supervisor for all harnesses.
- Do not copy private Codex or OpenCode internals. Match the user-visible resilience contract.

## 5. SOV implementation contract

### 5.1 Logical-turn supervisor

Keep `createAgent().run()` as the bounded embedded segment primitive.

Add an SDK logical-turn supervisor above it. SOV's native headless host and `sov run --sdk` use it by default.

The supervisor:

1. Persists the original user message once.
2. Runs a bounded segment.
3. Classifies the segment result.
4. Rehydrates the latest durable transcript before another segment.
5. Starts the next safe segment without adding the original user message again.
6. Finishes with one logical terminal.

State flow:

```text
admitted -> running
running -> completed
running -> checkpoint -> continuing -> running
running -> bounded retry -> running
running -> waiting for user
running -> cancelled
running -> actionable failure
running -> exhausted or stalled
```

### 5.2 Segment and logical limits

Keep current toolset defaults as segment model-call limits:

| Toolset | Segment limit |
|---|---:|
| chat | 1 |
| web | 6 |
| ops | 8 |
| coding | 100 |

They no longer decide whether the user request is complete.

Add a cumulative logical model-call limit. The default is 100. A caller can lower it. Starting a new segment cannot reset it.

`--deadline-ms` covers the full logical turn. Retries, compaction, model calls, tools, cleanup, and continuation segments share it.

Accumulate segment count, model calls, tool calls, tokens, known costs, provider retries, context recoveries, progress fingerprint, and repeated no-progress count.

### 5.3 Segment results

| Result | Action |
|---|---|
| `completed` | Finish the logical turn. |
| `max_turns` | Continue from durable state. |
| `max_tokens` | Continue the interrupted answer safely. |
| `checkin` | Ask the user when policy requires a check-in. Do not report an error. |
| Context overflow | Compact and retry within existing bounds. |
| Typed transient provider fault | Retry only when safe. |
| `/stop` or signal interruption | Stop. Do not auto-recover. |
| Auth, model, route, permission, config, or storage failure | Stop with the typed cause. |
| Unknown tool effect | Stop for inspection. |
| Repeated no progress | Stop with an actionable incomplete result. |

### 5.4 Output-token continuation

Use provider-native continuation when supported.

Otherwise persist verified partial output. Add one internal continuation message with a stable id and `origin: runtime`. Ask the model to continue without repetition. Hide the marker from normal presentation. Keep it in audit data. Do not run new-human-message hooks.

Do not guess when partial output has an ambiguous tool request. Discard an uncommitted request or stop when an effect may have started.

### 5.5 Provider retries

Retry only typed transient faults: 429, 502, 503, 504, a timeout before committed output, or a connection loss before an ambiguous effect.

Use at most three attempts for one provider request. Honor `Retry-After`. Otherwise use bounded exponential backoff with jitter.

Do not retry auth, unsupported model or effort, tier refusal, invalid request, permission denial, storage failure, corrupt session state, or an incomplete stream with an unknown effect.

All attempts keep the selected route, provider, account, model, and effort.

### 5.6 Durable state and restart

Persist a logical-turn record before the first model call. Store the logical-turn id, original user-message id, current and compacted session ids, route, provider, auth kind, model, effort, toolset, permission mode, policy digest, cwd and bundle identity, segment and cumulative budgets, last cause, progress fingerprint, status, and times.

Store no credential value or raw secret. Update atomically.

Expose a machine continuation command that accepts a logical-turn id or signed opaque token. It accepts no replacement prompt and does not rerun toolset selection. The in-process supervisor uses the same continuation path.

### 5.7 Tool-effect safety

Keep save-before-run.

Effectful tool calls have an idempotency identity and one state: `planned`, `started`, `completed`, `interrupted`, or `unknown`.

- Reuse a `completed` result. Never run it again.
- Continue an `interrupted` call only with a verified no-effect result.
- A `planned` call with no start receipt may run once.
- `started` and `unknown` stop recovery unless the tool has a verified idempotent status API.
- Replay a read-only tool only when the saved result cannot be restored and its contract allows replay.

Run the receipt check before each recovery. `recoverable: true` alone is not proof in new SOV releases.

### 5.8 Cross-segment progress

Build a progress fingerprint from transcript ids and count, completed tool receipts, cursor movement, compaction child id, saved assistant-text length, and terminal cause.

A segment progresses when one durable fact moves forward.

If two recovery attempts end with the same fingerprint and cause, return `continuation_stalled` with the repeated action. Productive pagination must not count as a loop.

### 5.9 Skill catalog efficiency

Add `detail` to `skills_list`:

- `names`: name only. Use for enumeration.
- `summary`: name and short description. Use for discovery.
- `activation`: name, description, and activation rules. Use before selecting a skill.

Keep cursor generation checks and context budgets.

Every page returns `total`, `returned`, `remaining`, `truncated`, optional `nextCursor`, `generation`, and `detail`.

The tool description tells the model to use `detail: names` for requests to list all skill names.

The current 33-skill catalog must fit in one `names` result with `limit: 100`. The expected path is one tool call and one closing model call.

Large catalogs can still page. Correctness cannot depend on one segment.

### 5.10 Isolation

Recovery does not widen a toolset, skill allow-list, group restriction, node guardrail, or permission. Every new tool call is checked again.

## 6. SOV wire contract

Do not emit `turn.error` for a safe internal `max_turns` continuation.

Emit non-terminal `turn.continuing` with session id, active session id, logical-turn id, cause, segment, and cumulative/limit counters. It contains no prompt, tool output, path, or credential.

Emit exactly one final `turn.completed` or `turn.error`.

`turn.completed` adds logical-turn id, segments used, cumulative usage, final active session id, and finish reason.

Add terminal codes:

- `continuation_exhausted`
- `continuation_stalled`
- `recovery_unsafe`
- `recovery_state_invalid`

Keep parsing older `needs_continuation`. New auto-recovery runs do not emit it for ordinary `max_turns`.

Add this capability to `session.started` and machine capabilities:

```json
{"logicalTurnRecovery":{"owner":"sov","version":1,"mode":"automatic"}}
```

## 7. Telekit implementation contract

### 7.1 Deadline

Pass the Telekit absolute turn ceiling to SOV as `--deadline-ms`.

Reserve ten seconds for terminal output and cleanup:

```text
sov deadline = max(1000 ms, Telekit max timeout - 10,000 ms)
```

Keep Telekit's timer as the final kill guard.

### 7.2 New SOV events

Treat `turn.continuing` as non-terminal activity. Refresh liveness, keep typing, keep the same turn-control object, keep cancellation and steering, preserve the latest active session id, and do not show a warning.

The normal progress profile may show one delayed `Continuing safely…` status. It must not send one message per segment.

### 7.3 Old-SOV compatibility

When `session.started` does not advertise SOV-owned recovery, accept the old structured event only when all are true:

- `type` is `turn.error`.
- `code` is `needs_continuation`.
- `recoverable` is true.
- `nextAction` is `resume`.
- A durable session id exists.
- The turn was not cancelled.
- Time remains.

Then:

1. Use the returned active session id.
2. Keep route, model, effort, toolset, permission mode, cwd, and attachment contract.
3. Do not call Jev again.
4. Send this fixed internal prompt:

   `Continue the unfinished current request from the durable session state. Do not repeat completed tool calls. Return the final answer when the request is complete.`

5. Keep one Telekit clock, relay, cancellation handle, and deadline.
6. Allow at most three compatibility launches.
7. Stop sooner when less than the cleanup reserve remains.
8. Stop on a non-recoverable event, invalid session pivot, or unknown effect.

After three requests, say:

`SOV saved the session but could not finish after three safe continuation attempts. Send “continue” to resume, or /new to start again.`

Do not use the shim when recovery is false, next action differs, the session id is missing, `/stop` occurred, the deadline passed, or SOV reports unsafe recovery, storage failure, or unknown effects.

The new SOV capability disables this shim.

## 8. Security

- No authentication or payment-path change.
- No provider or account fallback.
- No wider tools or permissions.
- Unknown effects stop recovery.
- Continuation records exclude secrets.
- Logs omit prompt text, tool output, and credentials.
- `/stop` always wins.
- Reject stale or corrupt continuation tokens.
- Serialize concurrent recovery with a turn lease.
- Reclaim an expired lease only after receipt and transcript checks pass.

## 9. Observability

Add SOV trace events: `logical_turn_start`, `segment_start`, `segment_end`, `recovery_start`, `recovery_end`, `provider_retry`, and `logical_turn_end`.

Include logical-turn id, segment, cause, cumulative counters, active session id, and elapsed time.

End outcomes are `completed`, `waiting_user`, `cancelled`, `failed`, `exhausted`, or `stalled`.

Do not count continuation segments as new user turns in usage, learning, hooks, or analytics.

Logs must show selected toolset and decision model, segment/logical limits, segment count, last cause, and whether recovery was SOV-owned or the Telekit compatibility shim.

## 10. Required tests

### SOV

- `createAgent().run()` keeps its one-segment contract.
- `max_turns` enters logical continuation.
- A new segment does not persist the original user message again.
- Counters accumulate.
- `max_tokens` continues without repeated text.
- `checkin` asks the user and does not auto-approve.
- Transient faults retry within bounds and keep the route.
- Auth, permission, storage, config, and unsupported-model failures do not retry.
- Two unchanged recovery fingerprints stop.
- Productive cursor movement is progress.
- Cancellation prevents retries and continuation.
- Completed effects never repeat.
- Started or unknown effects block recovery.
- Only one worker holds the logical-turn lease.
- `detail` projections and cursor rules pass.
- The current 33 long-description skills fit in one names page.
- A larger catalog pages exactly.
- The Owner's 33-skill `ops` request returns all names and a final answer in at most two model calls.
- A 250-skill fixture crosses the 8-call segment limit and completes.
- A web fixture crosses the 6-call limit and completes.
- A coding fixture does not repeat a write after recovery.
- Clean process restart continues a durable turn.
- Unknown effect after restart refuses recovery.
- Context overflow compacts, pivots, and completes within bounds.
- 429 plus `Retry-After` recovers.
- The stream has one terminal event and cumulative usage.

### Telekit

- Pass the remaining absolute deadline.
- `turn.continuing` is non-terminal and refreshes liveness.
- New SOV capability disables the shim.
- The exact 0.6.82 `needs_continuation` fixture resumes the same session.
- Compatibility keeps all fixed settings and does not call Jev again.
- A successful compatibility continuation returns one final reply.
- Three continuation requests stop with the explicit saved-session message.
- Unsafe, missing, cancelled, and expired cases do not relaunch.
- An active-session pivot does not return to the parent id.
- Other harness behavior stays unchanged.

## 11. Acceptance

1. The original Telegram `ops` test returns every installed skill name and a final answer.
2. No `needs_continuation` warning reaches the Owner for a safe segment boundary.
3. Jev runs once and selects `ops` once.
4. The authentication route stays fixed.
5. The 33-skill case uses no more than two model calls.
6. A catalog needing more than eight tool loops completes.
7. Safe tool results survive segment and process boundaries.
8. Completed effectful tools never repeat.
9. Unknown effects stop with an inspection message.
10. `/stop` prevents recovery.
11. The logical deadline emits a clean terminal before Telekit kills the process.
12. SOV emits one terminal and cumulative usage.
13. The Telekit shim fixes SOV 0.6.82 and stays off for new SOV.
14. Toolset isolation passes.
15. Existing adapter checks pass.

## 12. Delivery

Build SOV first. Open and review its PR. Then build Telekit against the final SOV wire. Open and review its PR. Do not merge the final delivery PRs. Do not release, install, restart Telekit, or change the active bot without separate authority.
