# In-process `/resume` for the TUI

**Date:** 2026-05-20
**Status:** Quick spec — awaiting authorization.
**Predecessors:** M11.5 inline picker card (`docs/specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md`), M6 compaction-complete session pivot (current implementation in `packages/tui/internal/app/app.go` around the `compaction_complete` case).
**Related:** ux-fixes round 1 — the "(in-process resume is not yet implemented — run the command above in a new shell.)" line in `src/commands/pickers.ts:formatResumeReport`.

## 1. Purpose

`/resume` currently picks a recent session via the inline `PickerCard`, then prints a `sov --resume <uuid>` command for the user to paste into a fresh shell. The session pivot does not happen in-process — the current TUI process keeps the live session, and the user must `/quit` and relaunch to load the picked one.

This spec extends `/resume` so that selecting a session reseats the TUI's active session in-place: the picked session's history hydrates into the transcript, subsequent turns route to the picked session, and the SSE stream switches over — all without a process restart.

## 2. Scope

**In scope:**
- New `sessionPivot` side-effect on the dispatcher response envelope.
- `/resume <uuid>` (the explicit-arg form already dispatched by the picker on Enter) emits `sessionPivot` instead of `formatResumeReport`'s text output when run from the TUI.
- TUI handler: clear transcript, set `m.sessionID = newID`, re-subscribe SSE against the new id, refetch messages + skills + commands, render a one-line confirmation card.
- A keyboard-undo affordance: `Ctrl-Z` or `/resume @prev` to swap back to the immediately-prior session (single step, not a stack).
- Tests: dispatcher envelope, TUI handler, end-to-end resume of a real persisted session.

**Out of scope:**
- REPL surface. The legacy readline REPL keeps its "print the command" behavior; M13 is removing the REPL surface and there is no value in dual-implementing.
- Multi-step undo. One-back is the affordance; a true history is not warranted for this verb.
- Cross-process handoff (e.g., resuming a session that another `sov` process has open). Out of scope; left to a future spec if the use case appears.
- Skill / command cache hydration race conditions across the pivot — handled by reusing the existing `fetchSkillsCmd` + `fetchCommandsCmd` pattern from `compaction_complete`. No new primitives.

## 3. Architecture

The pivot path mirrors `compaction_complete`, which already reseats `m.sessionID` mid-conversation when proactive compaction generates a new child session. The differences from compaction:

| Aspect | `compaction_complete` | `sessionPivot` (this spec) |
|---|---|---|
| Trigger | Server-emitted SSE event mid-turn | Slash-command dispatcher side-effect |
| New session relation | Child of the current parent | Unrelated, picked from disk |
| Transcript | Continues (compaction is implicit) | Cleared, then hydrated from `/messages` |
| SSE subscription | Stays on parent (bus is parent-keyed) | Re-subscribes against the new id |
| Skill / command caches | Refetched | Refetched (same code path) |
| Backlog fetch | Not needed | `fetchMessagesCmd` against new id |

### Wire protocol

Dispatcher response envelope gains an optional `sessionPivot` side-effect parallel to the existing `pickerOpen` and `themeChanged`:

```jsonc
{
  "output": "",
  "sideEffects": {
    "sessionPivot": {
      "sessionId": "632caf53-290d-426e-af92-2be6c2b0a7e6",
      "title": "(no title)",
      "model": "anthropic/claude-haiku-4-5-20251001",
      "provider": "anthropic",
      "messageCount": 0,
      "previousSessionId": "<the-id-we-came-from>"
    }
  }
}
```

`previousSessionId` is what the undo affordance reads. The server fills it from the dispatcher's `ctx.sessionId` at the time the `/resume <uuid>` call lands.

### TUI handler (app.go)

```go
case sessionPivotMsg:
    // Mirror compaction_complete:
    //   - Bump deltaGen + spinnerGen (ux-fixes round 1) so any
    //     in-flight idle ticks drop.
    //   - Cancel current SSE consumer; cancel & rebuild ctx so the
    //     event channel from the prior session goroutine drains.
    //   - Clear the transcript, append a "Resumed session <short-id>"
    //     card styled like the compaction pill.
    //   - m.sessionID = msg.sessionId
    //   - m.previousSessionID = msg.previousSessionId
    //   - Re-subscribe via transport.Consume on the new SSE URL.
    //   - Return tea.Batch(fetchMessagesCmd, fetchSkillsCmd,
    //     fetchCommandsCmd, m.waitEvent).
```

The cancel-and-rebuild step is non-trivial: the existing `m.ctx` / `m.cancel` pair is used by `transport.Consume`. We need to cancel cleanly so the SSE goroutine for the *old* session exits, then build a new ctx for the new session's stream. See `New()` for the original construction.

### Confirmation card

A new inline card component (or reuse `CompactionCard` with different copy) renders a one-line acknowledgment:

```
Resumed session 632caf53 · 0 messages · anthropic/claude-haiku-4-5
```

Theme.Border around it, theme.Dim text. Scrolls away like any other transcript content.

### Server side

A new branch in `runResumePicker` for the explicit-arg form:

```ts
if (explicit) {
  const chosen = sessions.find((s) => s.sessionId === explicit);
  if (!chosen) return `selection error: session ${explicit} not found.`;
  if (ctx.requestSessionPivot) {
    ctx.requestSessionPivot({
      sessionId: chosen.sessionId,
      title: chosen.title ?? null,
      model: chosen.model,
      provider: chosen.provider,
      messageCount: chosen.msgCount,
      previousSessionId: ctx.sessionId,
    });
    return '';
  }
  return formatResumeReport(chosen);  // REPL/non-TUI fallback
}
```

`CommandContext.requestSessionPivot` is a new optional capability mirroring `requestPicker` from M11.5. Server route in `src/server/routes/commands.ts` (or wherever the dispatcher is wired) collects the side-effect on the response.

## 4. Backwards compatibility + sequencing

- A picker selection dispatches `/resume <uuid>`. If the TUI is on a build that doesn't know `sessionPivot`, the server still emits it but the TUI ignores unknown side-effects, falling back to displaying the empty `output: ''`. **Mitigation:** the server-side change MUST ship together with the TUI-side change, or guard `requestSessionPivot` behind a feature flag observable by the TUI version handshake.
- During the pivot, in-flight turns on the old session should be cancelled. We can either:
  - **Hard cancel:** drop the old ctx; the prior session's runtime sees the SSE consumer disappear and the turn either completes silently or errors out into the trace log.
  - **Block pivot:** if `m.thinkingPending` or a tool is mid-execution, refuse the pivot with a status-line warning ("finish or /cancel the current turn before resuming").

Hard cancel is the simpler default. Block-pivot can be a follow-up if hard cancel surfaces user complaints.

## 5. Implementation tasks

1. **Wire:** add `SessionPivotEvent` to `src/server/schema.ts`; extend the dispatcher response envelope; thread `requestSessionPivot` through `CommandContext`.
2. **Server:** `src/commands/pickers.ts` — emit `sessionPivot` in the explicit-arg branch when `ctx.requestSessionPivot` exists; keep the legacy text path for REPL.
3. **TUI transport:** Go-side decoder for `sessionPivot` payload (`packages/tui/internal/transport/`).
4. **TUI app:** new `sessionPivotMsg`, handler in `Update`, cancel-and-rebuild ctx, clear transcript, re-subscribe SSE, batch refetch commands.
5. **TUI confirmation card:** reuse `CompactionCard` styling, new component or template.
6. **Undo affordance:** track `m.previousSessionID`; bind `Ctrl-Z` (or `/resume @prev`) to dispatch `/resume <prevId>`.
7. **Docs:** update `docs/usage.md` `/resume` description; update `src/commands/pickers.ts:formatResumeReport` to no longer be the primary path (it stays as the REPL fallback until M13 finishes); update `docs/conventions/tui-ux-patterns.md` if the confirmation-card pattern is new.

## 6. Test plan

| Layer | Test | Asserts |
|---|---|---|
| Unit (server) | `pickers.ts` explicit-arg → `requestSessionPivot` called | side-effect emitted with correct payload |
| Unit (server) | `pickers.ts` REPL fallback → `formatResumeReport` text | legacy text path still works when `requestSessionPivot` is undefined |
| Unit (TUI) | `sessionPivotMsg` Update branch | `m.sessionID` updated; transcript cleared; previousSessionID recorded |
| Unit (TUI) | Undo: dispatching `/resume <prevId>` while `m.previousSessionID` set | sessionID toggles back |
| Integration | Persist session A, start session B, /resume A, send turn | turn lands against A; backlog visible; old SSE goroutine exited |
| Integration | Pivot during streaming text_delta | hard cancel: in-flight turn drops; new session ready |
| Smoke | Real-Anthropic round-trip | manual: pick recent session, type prompt, verify turn carries through |

## 7. Risks + open questions

- **SSE goroutine leak.** If `m.cancel()` isn't called before re-subscribing, the old `transport.Consume` goroutine holds the prior session's bus subscription forever. The compaction path avoids this because the bus is parent-keyed and the goroutine stays alive intentionally. Resume needs an explicit teardown. Spec assumes a clean `ctx, cancel = context.WithCancel(...)` rebuild.
- **Approval modal mid-pivot.** If a permission modal is open when the user invokes `/resume`, the pivot would orphan the modal's request id (the prior session's runtime expects an approval POST). Need to either block the pivot while `m.permission != nil` or auto-deny the pending request on pivot.
- **Spinner / thinking state.** Clearing the transcript drops the spinner line. The ux-fixes round 1 deltaGen counter already handles invalidating pending idle ticks via `clearThinkingIfPending` (which the pivot would call).
- **Session ID validation.** The server's `runResumePicker` already validates `sessions.find((s) => s.sessionId === explicit)`. A user pasting an invalid uuid into `/resume <uuid>` directly (without going through the picker) gets the existing `"selection error"` text path — leave that branch alone.
- **Trajectory capture.** A pivot is a meaningful event for the trajectory log. Trace event TBD (probably `session_resumed` paralleling `compaction_complete`).
- **`previousSessionID` lifetime.** Only the most recently pivoted-from id is retained. A pivot that itself was prompted by an undo overwrites the slot — undo is single-step by design (see Section 2 out-of-scope).

## 8. Effort estimate

~3 wall-hours of focused work: ~1h server (schema + dispatcher + capability), ~1.5h TUI (handler + card + ctx rebuild + undo), ~0.5h tests. Excludes review.
