# Phase 16.1 M10.5 — Server-side slash-command dispatcher

**Date:** 2026-05-16
**Status:** Active — autonomous execution mode (user authorized)
**Predecessor:** M10 audit (`docs/07-history/state/2026-05-16-tui-parity-audit.md`) §"What's open / blockers for M11"; backlog item #40.
**Closes:** Backlog #40 (server-side built-in slash-command dispatcher). Unblocks M11 default-flip.

## 1. Purpose

The M10 parity audit (slice 1 HIGH finding) established that ~15-20 built-in slash commands (`/help`, `/clear`, `/cost`, `/tasks`, `/review`, `/agents`, `/permissions`, `/config`, `/commit`, `/history`, `/export`, `/status`, `/context-budget`, `/resume`, `/rollback`, `/continue`, `/stats`, plus PICKER/SESSION_OPS/INFO commands) work in `--ui repl` via `src/commands/registry.ts`'s `dispatchSlashCommand`, but `--ui tui` has no equivalent — those slashes silently fall through to the model as plain text.

M10.5 ships a single server route + a small Go-client router to close that gap. Approach A was selected (single unified `POST /sessions/:id/commands` route; existing dedicated routes for `/compact`, `/skills`, `/theme` preserved). After M10.5 ships, M11 can default-flip `--ui tui` without losing the built-in slash-command surface.

## 2. Scope

**In scope (M10.5):**
- `POST /sessions/:id/commands { name, args }` server route
- `buildCommandContext(...)` factory in `src/server/sessionContext.ts` (or a new file) — encapsulates per-request CommandContext construction from `Runtime` + `SessionContext`
- `CommandRequest` + `CommandResponse` Zod types
- Go client at `packages/tui/internal/transport/commands.go`
- Go-side slash router in `packages/tui/internal/app/app.go` (route to `/theme` client-side; `/compact`, `/skills`, `/skillname` to existing dedicated routes; rest to new `/commands` route)
- Tests on both sides (server unit tests for the route + Go-side tests for the client + routing)

**Out of scope (deferred to M10.6 / M11 prereq / post-flip):**
- Wiring `createClearedChildSession` (backs `/clear`) — M10 MEDIUM, separate backlog item.
- Wiring `createDefaultMemoryManager` + `resolveProjectScope` (backs `/memory`) — M10 MEDIUM.
- Wiring `appendProjectLocalPermissionRule` (permission "yes & remember (project)" persistence) — M10 MEDIUM.
- Mission FSM exposure via HTTP (intentionally CLI-only).
- Any new slash commands — M10.5 ships parity with the existing registry, not new functionality.

## 3. Architecture

```
Go TUI (input handler)
  │
  │ user types "/help" + ENTER
  ↓
  slashRouter:
    if name in {"theme"}                → client-side handler (existing)
    if name == "compact"                → POST /sessions/:id/compact (existing)
    if name == "skills"                 → POST /sessions/:id/skills (existing)
    if name in skills registry          → POST /sessions/:id/turns kind=skill (existing)
    else                                → POST /sessions/:id/commands { name, args }    ← NEW
  ↓
Server (Hono)
  POST /sessions/:id/commands route
    1. Validate session id, look up SessionContext
    2. Build CommandContext (per request) from Runtime + SessionContext
    3. dispatchSlashCommand(name, args, ctx)
    4. Format response envelope { output, error?, sideEffects? }
  ↓
Go TUI
  Render envelope output on transcript; honor sideEffects (e.g., hop sessionId on /clear)
```

The new server route is the ONLY new dispatch path. It reuses `dispatchSlashCommand` and the entire `COMMANDS` registry from `src/commands/registry.ts` — no duplication of the command-handling logic.

## 4. Components

### 4.1 Server-side (TypeScript)

**`src/server/routes/commands.ts` (NEW, ~120 LoC)**

```typescript
export function commandsRoute(runtime: Runtime): Hono {
  const r = new Hono();
  r.post('/sessions/:id/commands', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = runtime.sessionDb.getSession(sessionId);
    if (!session) {
      return c.json({ error: 'not found' }, 404);
    }
    const body = await c.req.json();
    const parsed = CommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const { name, args } = parsed.data;
    const sessionCtx = await getOrCreateSessionContext(runtime, sessionId);
    const cmdCtx = buildServerCommandContext(runtime, sessionCtx, sessionId);
    try {
      const result = await dispatchSlashCommand(name, args, cmdCtx);
      return c.json({
        output: result.output,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(cmdCtx.__sideEffects.size > 0
          ? { sideEffects: Object.fromEntries(cmdCtx.__sideEffects) }
          : {}),
      });
    } catch (err) {
      return c.json({
        output: '',
        error: err instanceof Error ? err.message : String(err),
      }, 200);
    }
  });
  return r;
}
```

**`src/server/sessionContext.ts` (CHANGED — add `buildServerCommandContext`)**

This factory mirrors `src/cli/dispatchCommand.ts:46+`'s wiring but for the server runtime. Maps:

| `CommandContext` field | Server source / behavior |
|---|---|
| `sessionId` | URL param |
| `cwd` | `runtime.opts.cwd` |
| `providerName` | `runtime.resolvedProvider.transport.name` |
| `model` | `runtime.model` |
| `bundlePath` | `runtime.bundle?.root ?? null` |
| `setModel(m)` | Mutate `runtime.model`; record `setModel` in `__sideEffects` |
| `clearHistory()` | Returns informative error string referencing backlog #41 (M10.5 scope-out); no actual mint |
| `getCost()` | `runtime.sessionDb.getSessionCost(sessionId)` |
| `compact()` | Reuses `runtime.compact(history, sessionId, signal)` — but normally the TUI hits the dedicated `/compact` route, so this server-side call is a fallback |
| `rollback()` | Returns informative error referencing backlog #41 |
| `tools` | `runtime.toolPool` (filtered for session toolsets) |
| `registry` | Built from `COMMANDS` + `buildSkillCommands(filteredSkills)` |
| `listSessions(limit)` | `runtime.sessionDb.listSessions(limit)` |
| `cleanupPhantomReviews()` | `runtime.sessionDb.cleanupPhantomReviews()` |
| `getMetrics()` | `runtime.sessionDb.getSessionMetrics(sessionId)` (minus `endedAtMs`) |
| `skills` | `sessionCtx.filteredSkills` (or filter on the fly) |
| `getLastAssistantText()` | Load history, scan backwards for last assistant text |
| `getMessages()` | `loadHistoryAsMessages(runtime.sessionDb, sessionId)` |
| `getPermissions()` | `{ mode: runtime.permissionMode, alwaysAllow: sessionCtx.alwaysAllow ?? [], layers: runtime.permissionSettings.layers }` |
| `requestExit()` | Record `exitRequested: true` in `__sideEffects` |
| `taskManager` | `runtime.taskManager` |
| `reviewManager` | `sessionCtx.reviewManager` |
| `harnessHome` | `runtime.harnessHome` |
| `getBudgetReport()` | `auditContextBudget({systemSegments, tools, skills, bundle})` — already imported for HarnessInfoTool wire in M10 |
| `expandToolBlock(n)` | Returns `{ ok: false, total: 0 }` — UI-specific; not applicable server-side. Documented in the response. |
| `resumeCheckin` | Undefined — REPL-specific pause/resume affordance |

The `__sideEffects` field is non-standard on `CommandContext` — it's a server-only Map captured in a closure. The route reads it post-dispatch to populate the response's `sideEffects` field.

**`src/server/schema.ts` (CHANGED — add types)**

```typescript
export const CommandRequestSchema = z.object({
  name: z.string().min(1).max(64),
  args: z.string().max(8192).default(''),
});

export const CommandResponseSchema = z.object({
  output: z.string(),
  error: z.string().optional(),
  sideEffects: z.object({
    newSessionId: z.string().optional(),
    exitRequested: z.boolean().optional(),
    modelChanged: z.string().optional(),
  }).optional(),
});
```

**`src/server/app.ts` (CHANGED — mount route)**

One line: `.route('/', commandsRoute(runtime))` in `buildAppWithRuntime`.

### 4.2 Go client side

**`packages/tui/internal/transport/commands.go` (NEW, ~80 LoC)**

```go
type CommandRequest struct {
    Name string `json:"name"`
    Args string `json:"args,omitempty"`
}

type CommandSideEffects struct {
    NewSessionID  string `json:"newSessionId,omitempty"`
    ExitRequested bool   `json:"exitRequested,omitempty"`
    ModelChanged  string `json:"modelChanged,omitempty"`
}

type CommandResponse struct {
    Output       string              `json:"output"`
    Error        string              `json:"error,omitempty"`
    SideEffects  *CommandSideEffects `json:"sideEffects,omitempty"`
}

func DispatchCommand(ctx context.Context, baseURL, sessionID, name, args string) (*CommandResponse, error) {
    // POST /sessions/<id>/commands with the request JSON; parse response.
}
```

**`packages/tui/internal/app/app.go` (CHANGED — slash router)**

The slash handler in the ENTER path grows a router function:

```go
func (m Model) routeSlashCommand(name, args string) tea.Cmd {
    switch name {
    case "theme":
        return m.handleThemeCommand(args)        // existing
    case "compact":
        return m.handleCompactCommand()           // existing route
    case "skills":
        return m.handleSkillsCommand(args)        // existing route (M9.6)
    }
    if m.isSkillName(name) {
        return m.dispatchSkillTurn(name)          // existing
    }
    return m.dispatchGenericCommand(name, args)   // NEW
}

func (m Model) dispatchGenericCommand(name, args string) tea.Cmd {
    return func() tea.Msg {
        resp, err := transport.DispatchCommand(ctx, m.baseURL, m.sessionID, name, args)
        return commandDispatchedMsg{resp: resp, err: err}
    }
}
```

The `commandDispatchedMsg` handler in `Update` renders the output on transcript, then applies sideEffects (hop sessionId, set model, exit).

**`packages/tui/internal/transport/commands_test.go` (NEW)** + **`app/app_test.go` additions** for routing tests.

## 5. Data flow

### Happy path — `/help`

1. User types `/help` + ENTER in TUI
2. Go TUI parses to `{name: "help", args: ""}` — not in client allowlist, not a dedicated route
3. Client POST `/sessions/<id>/commands` with `{"name": "help", "args": ""}`
4. Server validates sessionId; looks up SessionContext
5. Server builds CommandContext per-request; calls `dispatchSlashCommand("help", "", ctx)`
6. `formatHelp(ctx.registry)` returns the help text
7. Server returns `{output: "<help-text>"}`
8. Go TUI renders the output as a system message on transcript

### Side-effect path — `/clear` (unwired in M10.5)

1. User types `/clear` + ENTER
2. Go TUI POST `/sessions/<id>/commands` with `{"name": "clear", "args": ""}`
3. Server's `clearHistory()` returns the informative error string
4. Server returns `{output: "/clear is not yet wired in --ui tui...", error: undefined}` (output IS the message; no `error` field set so the TUI displays it as normal output)
5. Go TUI renders the message on transcript

### Side-effect path — `/model claude-sonnet-4-6`

1. User types `/model claude-sonnet-4-6`
2. Go TUI POST `/sessions/<id>/commands` with `{"name": "model", "args": "claude-sonnet-4-6"}`
3. Server's `setModel("claude-sonnet-4-6")` mutates `runtime.model` AND records `__sideEffects.set("modelChanged", "claude-sonnet-4-6")`
4. Server returns `{output: "model set to claude-sonnet-4-6", sideEffects: {modelChanged: "claude-sonnet-4-6"}}`
5. Go TUI renders output AND updates its own `m.model` display

### Unknown command path

1. User types `/healp` (typo)
2. Go TUI POST → server
3. `dispatchSlashCommand` returns `{output: "", error: "unknown command: /healp"}`
4. Server returns `{output: "", error: "unknown command: /healp"}`
5. Go TUI renders the error on transcript in `theme.Warning` style

## 6. Error handling

| Case | Server response | Go client behavior |
|---|---|---|
| Invalid session id | 400 `{error: "invalid session id"}` | Render error on transcript |
| Unknown session | 404 `{error: "not found"}` | Render error on transcript |
| Invalid request body | 400 `{error: "invalid request body"}` | Should not happen; log + transcript |
| Unknown command | 200 `{output: "", error: "unknown command: /name"}` | Render error in theme.Warning |
| Command throws | 200 `{output: "", error: "<msg>"}` | Render error in theme.Warning |
| Network failure | (no response) | Render local error on transcript |

`dispatchSlashCommand` itself returns `{output, error}` for known error cases (unknown command, parse errors). The route catches unexpected throws and converts them to 200 with the error field set. This keeps the TUI rendering uniform — every command produces a transcript-renderable result.

## 7. Testing strategy

### Server-side tests (`tests/server/routes/commands.test.ts`, new)

Mock provider, mock runtime. Test cases:
1. `POST /commands { name: "help" }` → 200, output non-empty, contains `/help`
2. `POST /commands { name: "cost" }` → 200, output mentions `tokens`
3. `POST /commands { name: "tasks" }` → 200, output mentions tasks
4. `POST /commands { name: "clear" }` → 200, output references backlog item / unwired notice
5. `POST /commands { name: "healp" }` → 200, error field set with `unknown command`
6. `POST /commands { name: "model", args: "claude-sonnet-4-6" }` → 200, sideEffects.modelChanged set
7. `POST /commands` with invalid session id → 400
8. `POST /commands` with unknown session → 404
9. `POST /commands` with missing `name` field → 400

### Go-side tests (`packages/tui/internal/transport/commands_test.go`, new)

1. `DispatchCommand` happy path against a mock HTTP server
2. Error response envelope parsed correctly
3. SideEffects parsed correctly
4. Network failure surfaces as error

### Go-side routing tests (`packages/tui/internal/app/app_test.go`, additions)

1. `/theme` → client-side handler invoked
2. `/compact` → existing dedicated route invoked
3. `/help` → new generic route invoked
4. `/skillname` (when in skills registry) → existing skill-turn route invoked
5. Unknown slash routes to /commands; envelope error rendered on transcript

## 8. Postmortem-rule compliance

- **Rule 1** — `src/ui/terminalRepl.ts` untouched. M10.5 adds server-side code only.
- **Rule 2** — no deletions. Pure additive.
- **Rule 3** — M10 audit informed this work; M10.5 itself doesn't need a new audit. M11 prereq audit (verify the dispatcher's parity matches REPL's slash surface) is part of the M11 milestone.
- **Rule 4** — `--ui tui` stays opt-in through M11. M10.5 is preparation; the flip still belongs to M11.

## 9. Deliverables

| Artifact | Location |
|---|---|
| Spec | This file |
| Plan | `plans/2026-05-16-phase-16-1-m10-5-slash-dispatcher.md` |
| Server route | `src/server/routes/commands.ts` |
| Server context builder | `src/server/sessionContext.ts` (extend) or new `src/server/commandContext.ts` |
| Schema | `src/server/schema.ts` (extend) |
| App mount | `src/server/app.ts` (one-line) |
| Go client | `packages/tui/internal/transport/commands.go` |
| Go types | `packages/tui/internal/transport/types.go` (extend) |
| Go router | `packages/tui/internal/app/app.go` (extend) |
| Tests | `tests/server/routes/commands.test.ts`, `packages/tui/internal/transport/commands_test.go`, `packages/tui/internal/app/app_test.go` additions |
| ADRs | M10.5-01..03 in `DECISIONS.md` (methodology, side-effects field design, unwired-command informative-error convention) |
| State snapshot | `docs/07-history/state/2026-05-16-m10-5.md` |
| Testing-log entry | `docs/06-testing/testing-log.md` (newest-first) |
| Boot pointer | `CLAUDE.md` / `AGENTS.md` updated |

## 10. Sign-off

Approved by user (Approach A, autonomous-mode authorization). Implementation proceeds without further check-ins until M10.5 close-out.
