# Phase 16.1 M10.5 — Slash dispatcher implementation plan

**Spec:** [`specs/2026-05-16-phase-16-1-m10-5-slash-dispatcher-design.md`](specs/2026-05-16-phase-16-1-m10-5-slash-dispatcher-design.md)
**Mode:** Fully autonomous (user authorized)

## Tasks (ordered)

### T1 — Server-side: types in schema.ts
- Add `CommandRequestSchema` + `CommandResponseSchema` Zod types
- Export inferred types `CommandRequest`, `CommandResponse`
- One commit when wired

### T2 — Server-side: CommandContext builder
- Add `buildServerCommandContext(runtime, sessionCtx, sessionId)` exported from `src/server/sessionContext.ts` (or `src/server/commandContext.ts` if it would keep that file <800 LoC)
- Maps every CommandContext field per §4.1 of the spec
- Returns the ctx + a `sideEffects` collector so the route can read mutations
- Unwired-subsystem fields (clearHistory, rollback) return informative error strings

### T3 — Server-side: route
- Create `src/server/routes/commands.ts` with the `POST /sessions/:id/commands` handler
- Validation: session id, body parsing
- Look up SessionContext via existing `getOrCreateSessionContext` (or equivalent)
- Build CommandContext, call dispatchSlashCommand, format envelope
- Mount in `src/server/app.ts`

### T4 — Server-side: tests
- New file `tests/server/routes/commands.test.ts`
- Cases per spec §7:
  - happy path: /help, /cost, /tasks
  - unwired commands: /clear returns informative output
  - unknown commands: error field set
  - side-effects: /model `args` sets modelChanged
  - error envelope: invalid session id, unknown session, malformed body
- Mock provider (`SOV_TEST_MOCK_PROVIDER=1`)

### T5 — Go client: types + DispatchCommand
- Create `packages/tui/internal/transport/commands.go`
- Define `CommandRequest`, `CommandResponse`, `CommandSideEffects` structs
- Implement `DispatchCommand(ctx, baseURL, sessionID, name, args) (*CommandResponse, error)`
- Marshal request, POST with proper Content-Type, unmarshal response

### T6 — Go client: tests
- `packages/tui/internal/transport/commands_test.go`
- httptest.Server fixture; assert envelope parsing on happy/error/sideEffects paths
- Network-failure simulation

### T7 — Go app: slash routing
- Update `packages/tui/internal/app/app.go` ENTER handler
- Add `routeSlashCommand(name, args)` function dispatching by name
- Add `dispatchGenericCommand(name, args)` Cmd builder
- Add `commandDispatchedMsg` and its handler in `Update`
- Render output on transcript; apply sideEffects (hop sessionID on newSessionId; exit on exitRequested; update m.model on modelChanged)

### T8 — Go app: tests
- Add cases to `app/app_test.go` covering the routing decision (/theme, /compact, /skills, /skillname, generic)
- Mock transport.DispatchCommand via injection or test-mode flag

### T9 — Real-Anthropic smoke (sanity check, optional cost ~$0.02)
- Extend `tests/parity/m10RealAnthropicSmoke.test.ts` OR new `tests/parity/m10_5SlashDispatcher.test.ts`
- 2 prompts: `/help` (via the new route) and `/cost` (after a brief turn)
- Verify output renders correctly

### T10 — Close-out
- ADRs M10.5-01..03 in `DECISIONS.md`
- State snapshot `docs/07-history/state/2026-05-16-m10-5.md`
- Testing-log entry (newest-first)
- CLAUDE.md / AGENTS.md state-pointer update; verify byte-identical mirror
- Backlog #40 marked closed; reference the commit chain
- Open new MEDIUM backlog items for the M10 cascading items now traceable through the dispatcher (#41 createClearedChildSession, #42 createDefaultMemoryManager)

### T11 — Pre-commit gate + sov upgrade
- `bun run lint && bun run typecheck && bun run test`
- `cd packages/tui && go test ./... && cd -`
- `sov upgrade`

### T12 — Push
- `git push origin master`

## Execution rules

- Atomic commits per CLAUDE.md convention (T1+T2 may bundle; T3+T4 separate; T5+T6 separate; T7+T8 separate; T9 separate; T10 separate; T11 in-line; T12 final).
- No deletion of any code under `src/` (Rule 2).
- No edits to `src/ui/terminalRepl.ts` (Rule 1).
- `--ui tui` default stays `repl` in `src/main.ts` (Rule 4).
- Autonomous decision authority for: implementation choices within spec scope, test additions, bug fixes uncovered during work, doc updates. Re-engage user only if scope must materially change (e.g., a new HIGH gap surfaces).

## Estimated effort

- T1-T4: ~1 session (server-side route + tests)
- T5-T8: ~1 session (Go client + routing + tests)
- T9-T12: ~0.5 session (smoke + close-out + push)
- **Total: ~2.5 sessions**

Budget for real-Anthropic smoke: ~$0.02 (under $2.00 ceiling).
