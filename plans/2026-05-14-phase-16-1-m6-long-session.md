# Phase 16.1 M6 — Long-Session Survival Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Wire three subsystems — **microcompaction** (per-part `tool_result` clearing during long turns), **full compactor** (`/compact` slash command + threshold-triggered `shouldCompactProactively`), and **context-overflow auto-recovery** (`createClearedChildSession` retry path) — into the Phase 16.1 split-process architecture. Three prereq boxes flip in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` (rows 7, 8, 15). `--ui tui` reaches feature parity with terminalRepl on the surfaces a long session needs first.

**Architecture:** Server-side wiring extends `RuntimeOptions` / `Runtime` (the M4/M5 pattern). Microcompaction is the smallest box: `query()` already supports `microcompactConfig`; M6 sources it from settings and threads it through. The compactor introduces one new helper module (`src/server/compactor.ts`) that wraps `compactSession()` with runtime-provided defaults. The compaction call site lives in `runTurnInBackground` in two places: (a) a proactive check before the `query()` call, (b) a single retry on `isContextOverflowError`. Explicit `/compact` is exposed as a new route `POST /sessions/:id/compact` that invokes the same helper synchronously. The Go TUI gains a client-side `/compact` keybinding + a handler for the new `compaction_complete` SSE event so the active session id hops to the child after a compaction.

**Tech Stack:** TS / Bun (server), Hono routes, `bun:test`; Go 1.24 / Bubble Tea (client). No new dependencies introduced.

**Spec references:**
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §10 (M6 row), §13 (open Qs deferred to plan)
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` rows 7 (Compactor), 8 (Microcompaction), 15 (Context-overflow auto-recovery)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4 (terminalRepl untouched; coexistence; audit before flip)
- `plans/2026-05-14-phase-16-1-m5-user-noticed.md` — M5 plan for the wiring-into-server pattern this milestone repeats
- `src/ui/terminalRepl.ts:1333-1348` (proactive check), `:1659-1675` (overflow recovery), `:1720-1754` (`compactNow` shape) — reference implementations to mirror
- `src/compact/compactor.ts:87` (`compactSession`), `:168` (`shouldCompactProactively`)
- `src/compact/microcompact.ts:61` (`microcompact`), `:98` (`shouldMicrocompact`), `:196` (`buildMicrocompactConfig`)
- `src/agent/sessionRecovery.ts:20` (`createClearedChildSession` — used inside the compactor when the auxiliary summarize call itself overflows)
- `src/providers/errors.ts:81` (`isContextOverflowError`)
- `src/agent/sessionDb.ts:479` (`recordCompactionLineage`), `:491` (`getCompactionsForParent`) — lineage already persisted

**Scope guard — what M6 does NOT do:**
- No visual polish on the in-transcript "compaction summary" marker. M6 emits the SSE event + a transcript line; M9 owns the styled card.
- No auxiliary-provider selection (smaller cheap model for summarization). The summarize callback uses the same provider/model as the parent session. Cheap-model auxiliary is a Phase 15 / M8 polish.
- No user-configurable proactive threshold beyond the existing settings cascade. `userSettings.compaction.proactiveThresholdPct` is honored if set; default `0.75` from `shouldCompactProactively`'s built-in default.
- No multi-retry on overflow. One retry; if the post-compaction turn ALSO overflows, it surfaces as `turn_error`. Matches terminalRepl behavior.
- No proactive check on subsequent turns within the same connection — the check fires once per `runTurnInBackground` invocation, before its `query()` call. Identical to terminalRepl's per-turn cadence.
- No default-flip. `--ui tui` stays opt-in through M11.
- terminalRepl untouched (Postmortem Rule 1).

---

## Inline Decisions (resolutions of Spec §13 Open Qs for this milestone)

| Decision | Resolution | Rationale |
|---|---|---|
| **M6-01 — Compaction creates a new session id; client tracks it** | `POST /sessions/:id/compact` returns `{ activeSessionId: <newId>, summary, ... }`. The proactive + overflow paths emit `compaction_complete { previousSessionId, activeSessionId, summary }` on the parent session's SSE bus. Subsequent `runTurnInBackground` calls inside the same handler use the new id immediately. The TUI updates its in-memory `sessionID` on receiving `compaction_complete` so the next user turn POSTs to `/sessions/<newId>/turns`. | Mirrors terminalRepl's in-process `activeSessionId` swap. SessionDb already persists lineage via `recordCompactionLineage`, so `--resume <oldId>` could later resolve to the latest descendant via a server-side helper if/when needed (deferred — out of scope). |
| **M6-02 — Overflow recovery retries the same turn once** | Wrap the `query()` iteration in try/catch. On `isContextOverflowError`, call `runtime.compact(...)`, emit `compaction_complete`, then re-invoke `query()` against the new session id with the compacted history + the original user message re-appended. Second overflow → `turn_error`. | Matches terminalRepl `:1659-1675`. Two-retry loops mask deeper bugs and increase blast radius; one retry is the established contract. |
| **M6-03 — `/compact` route is synchronous** | `POST /sessions/:id/compact` runs compaction inline (no SSE-driven background flow), returns 200 with `{ activeSessionId, summary, estimatedBeforeTokens, estimatedAfterTokens, usedAuxiliary }` once `compactSession` resolves. Errors return 4xx/5xx with a JSON body. | The TUI's `/compact` is a user-blocking action; the user expects the prompt to wait. SSE-driven flow adds complexity without payoff for this verb. Matches the M5 approval-route shape (synchronous resolution, JSON body). |
| **M6-04 — Microcompaction config sourced from settings** | `buildRuntime` calls `buildMicrocompactConfig(userSettings.microcompaction)` and exposes it on `Runtime.microcompactConfig`. The turns route reads it from `runtime` and passes it to `query()`. | Mirrors how terminalRepl wires it (`src/ui/terminalRepl.ts:1415`). One source of truth, easy to override in tests via `RuntimeOptions.microcompactConfig` (added in T1). |
| **M6-05 — Proactive threshold sourced from settings** | `shouldCompactProactively`'s `threshold` parameter is sourced from `userSettings.compaction.proactiveThresholdPct` when present; otherwise the function's built-in default (`0.75`) applies. No new schema field added if one doesn't already exist — implementer reads `src/config/schema.ts` and either uses an existing field or skips the override and relies on the default. | Avoids inventing config surface for M6. The threshold is rarely tuned; default `0.75` is the documented contract. |
| **M6-06 — Summarize callback uses the parent's own provider/model** | The `summarize` callback passed into `compactSession` invokes `runtime.resolvedProvider.transport.stream(...)` with `runtime.model`. No auxiliary-provider routing. | Auxiliary cheap-model selection is Phase 15 / M8 polish. Same-provider summarization is the safe default — never surprises the user with a model they didn't configure. |

---

## File Structure

### New files

| Path | Responsibility | Approx. LoC |
|---|---|---|
| `src/server/compactor.ts` | `buildServerCompactor(runtime)` factory returning a `compact(history, sessionId, signal) => Promise<CompactResult>` callable. Closes over `runtime.sessionDb`, `runtime.resolvedProvider`, `runtime.model`, `runtime.systemSegments`. Wraps `compactSession()` with runtime-provided defaults + a same-provider `summarize` callback. | ~80 |
| `src/server/routes/compact.ts` | `compactRoute(runtime)` Hono sub-router. `POST /sessions/:id/compact` reads the session, builds history from `sessionDb.getMessages(sessionId)`, calls `runtime.compact(...)`, returns the JSON result. 404 for unknown session id. | ~70 |
| `tests/server/compactor.test.ts` | Unit tests for `buildServerCompactor`: produces a `compact` function; the function calls `compactSession` with the runtime's provider/model/systemPrompt; lineage is recorded in sessionDb; the same-provider summarize callback is wired correctly. | ~140 |
| `tests/server/routes/compact.test.ts` | Route tests: POST resolves with `{ activeSessionId, summary, ... }`; unknown session id → 404; aborted request → bus dispose path is clean. | ~120 |
| `tests/server/turns.microcompact.test.ts` | Drive a turn with a tiny `triggerThresholdPct` + several mock-provider tool calls; assert `microcompact` SSE event fires inside the turn loop. | ~140 |
| `tests/server/turns.proactiveCompact.test.ts` | Drive a turn with a hydrated history that exceeds the proactive threshold; assert `compaction_complete` fires before `text_delta`; assert subsequent persistence lands on the new session id. | ~160 |
| `tests/server/turns.overflowRecovery.test.ts` | Mock provider throws a context-overflow error on first call, succeeds on second. Assert: `compaction_complete` fires, the same turn retries, the user-visible final message reflects the second call's content, lineage is recorded. | ~180 |

### Modified files

| Path | Modification |
|---|---|
| `src/server/runtime.ts` | (a) Extend `RuntimeOptions` with optional `microcompactConfig` injection (test override) + optional `proactiveCompactThreshold` (test override); (b) extend `Runtime` with `microcompactConfig: MicrocompactConfig`, `proactiveCompactThreshold: number`, `compact: ServerCompactor`; (c) `buildRuntime` calls `buildMicrocompactConfig(userSettings.microcompaction)`, resolves the threshold from settings (or default), constructs the compactor via `buildServerCompactor()`. |
| `src/server/routes/turns.ts` | (a) Pass `runtime.microcompactConfig` to `query()`; (b) before the `query()` call: build the message history, call `shouldCompactProactively`, and if true invoke `runtime.compact(...)` + emit `compaction_complete` + reassign the local `sessionId` variable; (c) wrap the `query()` iteration in try/catch — on `isContextOverflowError` from `terminal.error` OR a thrown error, perform the same compact-then-reissue dance once, then re-enter the iteration loop. |
| `src/server/app.ts` | Mount the new `compactRoute(runtime)` on the Hono app. |
| `src/server/eventBus.ts` | Add a typed `CompactionCompleteEvent` to the wire-event union: `{ type: 'compaction_complete', seq, sessionId (parent), activeSessionId (new), summary, estimatedBeforeTokens, estimatedAfterTokens }`. (If the union is in a separate types file, modify there instead.) |
| `packages/tui/internal/app/app.go` | (a) Handle `compaction_complete` SSE events: render a transcript marker line, update `m.sessionID` to `activeSessionId`; (b) intercept `/compact` user input client-side: POST to `/sessions/<currentId>/compact` and update `m.sessionID` from the response. |
| `packages/tui/internal/transport/api.go` | Add `PostCompact(ctx, baseURL, sessionID) (*CompactResponse, error)` HTTP client. (Mirrors the M5 `PostApproval` shape introduced in M5 T9 — implementer references that file.) |
| `tests/cli/tuiLauncherIntegration.test.ts` | Extend the M5 integration smoke with three new scenarios: microcompact event fires, proactive compaction completes through tuiLauncher → buildRuntime → query path, overflow-then-retry path completes. |
| `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` | Flip checkboxes for rows 7, 8, 15 with `(M6 — 2026-05-XX)` annotation. |
| `DECISIONS.md` | Add ADR stubs: M6-01 (session-id swap on compact), M6-02 (single retry on overflow), M6-03 (synchronous /compact route). M6-04 / M6-05 / M6-06 are config decisions, not architectural — note them in the snapshot, not as ADRs. |
| `docs/07-history/state/2026-05-XX.md` (close-out date) | New close-out snapshot — supersedes `docs/07-history/state/2026-05-14.md`. |
| `CLAUDE.md` / `AGENTS.md` | Update the state-snapshot pointer to the new dated file. Byte-identical mirror invariant preserved. |

---

## Files Touched (by task)

| Task | Modifies | Creates | Tests |
|---|---|---|---|
| T1 | `src/server/runtime.ts`, `src/server/routes/turns.ts` | — | `tests/server/turns.microcompact.test.ts`, extends `tests/server/runtime.test.ts` |
| T2 | `src/server/runtime.ts` | `src/server/compactor.ts` | `tests/server/compactor.test.ts` |
| T3 | `src/server/routes/turns.ts`, `src/server/eventBus.ts` (or types file) | — | `tests/server/turns.proactiveCompact.test.ts` |
| T4 | `src/server/routes/turns.ts` | — | `tests/server/turns.overflowRecovery.test.ts` |
| T5 | `src/server/app.ts` | `src/server/routes/compact.ts` | `tests/server/routes/compact.test.ts` |
| T6 | `packages/tui/internal/app/app.go`, `packages/tui/internal/transport/api.go` | — | (smoke covered in T7) |
| T7 | `tests/cli/tuiLauncherIntegration.test.ts`, `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `DECISIONS.md`, `docs/07-history/state/<date>.md`, `CLAUDE.md`, `AGENTS.md` | `docs/07-history/state/<date>.md` | (extends integration test with three scenarios) |

---

## Task 1: Wire microcompaction config into `query()` through the turns route

**Goal:** `buildRuntime` constructs a `MicrocompactConfig` from settings and exposes it on `Runtime`. The turns route forwards it to `query()`. With a low `triggerThresholdPct` and several mock-provider tool calls in a single turn, `query()` emits a `microcompact` event inside the turn loop. Closes prereq row 8.

**Files:**
- Modify: `src/server/runtime.ts`
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.microcompact.test.ts`

**Spec / inventory pointers:**
- `src/compact/microcompact.ts:196` — `buildMicrocompactConfig(settings?: Partial<MicrocompactConfig>)`
- `src/core/query.ts:403-423` — existing microcompaction call site inside the turn loop
- `src/core/types.ts:115` — `microcompactConfig?: MicrocompactConfig` field on `QueryParams`
- `src/ui/terminalRepl.ts:1415` — reference call: `microcompactConfig: buildMicrocompactConfig(userSettings.microcompaction)`

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.microcompact.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';
import { ServerEventBus } from '../../src/server/eventBus.js';

describe('turns route — microcompaction', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t1-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('emits microcompact event when threshold exceeded mid-turn', async () => {
    // Arrange: small threshold + mock provider issuing 4 Bash calls in one turn.
    const provider = new MockProvider({
      script: [
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo a' } },
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo b' } },
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo c' } },
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo d' } },
        { kind: 'text', text: 'done' },
      ],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
      microcompactConfig: {
        enabled: true,
        keepRecent: 1,
        triggerThresholdPct: 1, // any compactable token triggers
        compactableTools: { Bash: true },
      },
    });

    const bus = new ServerEventBus();
    const events: string[] = [];
    bus.subscribe((evt) => events.push(evt.type));

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    // Act
    await runTurnInBackground({
      runtime,
      sessionId,
      bus,
      userText: 'do four bash calls then say done',
    });

    // Assert
    expect(events).toContain('microcompact');

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/turns.microcompact.test.ts`
Expected: FAIL — either `runtime.microcompactConfig` is undefined, or the turns route doesn't pass it to `query()`, or the `RuntimeOptions.microcompactConfig` injection point doesn't exist.

- [ ] **Step 3: Add `microcompactConfig` to `RuntimeOptions` + `Runtime`**

In `src/server/runtime.ts`, in `RuntimeOptions` (after `preflight?: boolean;`):

```typescript
  /** Per-part tool-result clearing config used inside the query() turn
   *  loop. When omitted, buildRuntime sources from
   *  userSettings.microcompaction via buildMicrocompactConfig (M6-04). */
  microcompactConfig?: MicrocompactConfig;
```

In the `Runtime` type (after `taskManager: TaskManager;`):

```typescript
  /** Per-part tool-result clearing config. Always populated — either the
   *  caller-supplied value or buildMicrocompactConfig(userSettings.microcompaction).
   *  The turns route reads this and passes it to query(). */
  microcompactConfig: MicrocompactConfig;
```

Add the import at the top of the file:

```typescript
import { buildMicrocompactConfig } from '../compact/microcompact.js';
import type { MicrocompactConfig } from '../compact/microcompact.js';
```

- [ ] **Step 4: Construct it in `buildRuntime`**

In `src/server/runtime.ts`, inside `buildRuntime` after the M5 subagent block (around line 480, just before the return object), add:

```typescript
  const microcompactConfig =
    options.microcompactConfig ?? buildMicrocompactConfig(userSettings.microcompaction);
```

In the return object, add:

```typescript
    microcompactConfig,
```

- [ ] **Step 5: Pass it to `query()` from the turns route**

In `src/server/routes/turns.ts`, in the `query({...})` call (around line 172), add:

```typescript
      microcompactConfig: runtime.microcompactConfig,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/server/turns.microcompact.test.ts`
Expected: PASS — `microcompact` event present in the captured event types.

- [ ] **Step 7: Run the full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green; the existing tests should still pass since we added an optional field with a sensible default.

- [ ] **Step 8: Commit**

```bash
git add src/server/runtime.ts src/server/routes/turns.ts tests/server/turns.microcompact.test.ts
git commit -m "$(cat <<'EOF'
feat(server): M6 T1 — wire microcompactConfig into query through turns route

Sources MicrocompactConfig from userSettings.microcompaction (M6-04),
exposes on Runtime, turns route forwards to query(). Closes prereq row 8
(microcompaction).
EOF
)"
```

---

## Task 2: Build the server-side compactor primitive

**Goal:** Create `src/server/compactor.ts` exporting `buildServerCompactor(runtime) → ServerCompactor`. The returned `compact(history, sessionId, signal)` function calls `compactSession()` with the runtime's provider/model/system-prompt and a same-provider `summarize` callback (M6-06). Lineage is recorded via `sessionDb.recordCompactionLineage`. `Runtime` gains a `compact` field exposing this callable.

**Files:**
- Create: `src/server/compactor.ts`
- Modify: `src/server/runtime.ts`
- Create: `tests/server/compactor.test.ts`

**Spec / inventory pointers:**
- `src/compact/compactor.ts:87` — `compactSession(options: CompactOptions): Promise<CompactResult>`
- `src/agent/sessionDb.ts:479` — `recordCompactionLineage(parent, child)`
- `src/ui/terminalRepl.ts:1720-1754` — `compactNow` reference shape

- [ ] **Step 1: Write the failing test**

Create `tests/server/compactor.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { Message } from '../../src/core/types.js';

describe('buildServerCompactor', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t2-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime.compact resolves with a CompactResult and records lineage', async () => {
    const provider = new MockProvider({
      script: [{ kind: 'text', text: 'A summary of prior context.' }],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];

    const result = await runtime.compact(history, sessionId, new AbortController().signal);

    expect(result.parentSessionId).toBe(sessionId);
    expect(result.newSessionId).not.toBe(sessionId);
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);

    // Lineage persisted
    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.childSessionId).toBe(result.newSessionId);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/compactor.test.ts`
Expected: FAIL — `runtime.compact` is undefined.

- [ ] **Step 3: Create `src/server/compactor.ts`**

```typescript
import { compactSession } from '../compact/compactor.js';
import type { CompactResult } from '../compact/compactor.js';
import type { Message } from '../core/types.js';
import type { Runtime } from './runtime.js';

export type ServerCompactor = (
  history: readonly Message[],
  sessionId: string,
  signal: AbortSignal,
) => Promise<CompactResult>;

/** Wraps compactSession() with runtime-provided defaults. The summarize
 *  callback uses the runtime's own provider/model (M6-06) — auxiliary
 *  cheap-model selection is deferred to Phase 15 / M8. Lineage recording
 *  happens inside compactSession itself; the caller does not need to call
 *  recordCompactionLineage separately. */
export function buildServerCompactor(
  runtime: Pick<Runtime, 'sessionDb' | 'resolvedProvider' | 'model' | 'systemSegments'>,
): ServerCompactor {
  return async function compact(history, sessionId, signal) {
    return compactSession({
      db: runtime.sessionDb,
      sessionId,
      model: runtime.model,
      providerName: runtime.resolvedProvider.transport.name,
      systemPrompt: runtime.systemSegments,
      history: [...history],
      summarize: async (input) => {
        const stream = runtime.resolvedProvider.transport.stream({
          model: runtime.model,
          messages: input.messages,
          systemPrompt: input.systemPrompt,
          maxTokens: input.maxTokens,
          signal,
        });
        let text = '';
        for await (const event of stream) {
          if (event.type === 'text_delta') text += event.delta;
        }
        return text;
      },
    });
  };
}
```

> NOTE for implementer: the exact `summarize` callback signature lives in `src/compact/compactor.ts` — read the `CompactOptions.summarize` type before finalizing the body. The shape above mirrors how terminalRepl wires it (`src/ui/terminalRepl.ts:1731-1745`); copy that pattern verbatim if the field names differ.

- [ ] **Step 4: Wire it onto `Runtime`**

In `src/server/runtime.ts`:

```typescript
import { buildServerCompactor } from './compactor.js';
import type { ServerCompactor } from './compactor.js';
```

Extend `Runtime` (after `microcompactConfig: MicrocompactConfig;` from T1):

```typescript
  /** Server-side compaction primitive. Wraps compactSession() with the
   *  runtime's provider/model/systemPrompt + a same-provider summarize
   *  callback. Used by (a) proactive check in turns route, (b) overflow
   *  recovery in turns route, (c) POST /sessions/:id/compact route. */
  compact: ServerCompactor;
```

In `buildRuntime`, after constructing `microcompactConfig`:

```typescript
  // Build compactor closure once; field is bound after the return object
  // is constructed (it needs the same Runtime shape it's installed onto).
```

Then in the return object:

```typescript
    compact: undefined as unknown as ServerCompactor, // bound below
```

After the `const runtime: Runtime = { ... };` assignment (the existing pattern), add:

```typescript
  runtime.compact = buildServerCompactor(runtime);
```

> If `buildRuntime` doesn't currently pin the return object to a named `runtime` variable, refactor it minimally to do so — the closure over `runtime` is the cleanest way to give the compactor access to itself without a circular construction. Alternative: pass `{ sessionDb, resolvedProvider, model, systemSegments }` directly to `buildServerCompactor` from local variables in scope, no `runtime` reference needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/server/compactor.test.ts`
Expected: PASS — `runtime.compact` returns a `CompactResult` with `parentSessionId`, `newSessionId`, and `summary`; lineage row is persisted.

- [ ] **Step 6: Run the full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/server/compactor.ts src/server/runtime.ts tests/server/compactor.test.ts
git commit -m "$(cat <<'EOF'
feat(server): M6 T2 — buildServerCompactor primitive on Runtime

ServerCompactor closure wraps compactSession() with runtime-provided
provider/model/systemPrompt. Same-provider summarize callback (M6-06).
Used by T3 (proactive), T4 (overflow recovery), T5 (/compact route).
EOF
)"
```

---

## Task 3: Proactive compaction check in `runTurnInBackground`

**Goal:** Before the `query()` call in `runTurnInBackground`, build the message history and call `shouldCompactProactively`. If true: invoke `runtime.compact(...)`, emit `compaction_complete` SSE event, reassign the local `sessionId` to the new id, and proceed with the turn against the new session. Closes the proactive half of prereq row 7.

**Files:**
- Modify: `src/server/routes/turns.ts`
- Modify: `src/server/eventBus.ts` (or wherever the SSE event union lives)
- Create: `tests/server/turns.proactiveCompact.test.ts`

**Spec / inventory pointers:**
- `src/compact/compactor.ts:168` — `shouldCompactProactively({ messages, systemPrompt, contextLength, threshold })`
- `src/ui/terminalRepl.ts:1333-1348` — proactive check reference

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.proactiveCompact.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';
import { ServerEventBus } from '../../src/server/eventBus.js';

describe('turns route — proactive compaction', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t3-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('compaction_complete fires before text_delta when history exceeds threshold', async () => {
    const summarizeProvider = new MockProvider({
      script: [{ kind: 'text', text: 'Summary of prior history.' }],
    });
    const turnProvider = new MockProvider({
      script: [{ kind: 'text', text: 'fresh response' }],
    });
    // Build runtime with a threshold of 0 so any history triggers compaction.
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: turnProvider,
      proactiveCompactThreshold: 0, // injection point added in this task
    });
    // Override provider for the summarize step via a swap:
    // (or arrange MockProvider to script both calls back-to-back)

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    // Pre-populate enough history to exceed any threshold
    runtime.sessionDb.saveMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'previous turn'.repeat(500) }],
    });

    const bus = new ServerEventBus();
    const events: { type: string }[] = [];
    bus.subscribe((evt) => events.push({ type: evt.type }));

    await runTurnInBackground({
      runtime,
      sessionId,
      bus,
      userText: 'next turn',
    });

    const types = events.map((e) => e.type);
    const compactIdx = types.indexOf('compaction_complete');
    const textIdx = types.indexOf('text_delta');
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(compactIdx);

    // New session id was recorded; turn ran against the child
    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);

    await runtime.dispose();
  });
});
```

> NOTE for implementer: `MockProvider` may need to script both summarize-call and turn-call output. If its current API only supports one script per instance, either (a) add a "next response" injection point, or (b) construct two providers and arrange the summarize callback to use one while query() uses the other. Read the existing test fixtures for `MockProvider` to pick the cleanest approach.

- [ ] **Step 2: Add `proactiveCompactThreshold` to `RuntimeOptions` + `Runtime`**

In `src/server/runtime.ts`, in `RuntimeOptions`:

```typescript
  /** Override the proactive-compaction threshold (fraction of context
   *  length, e.g. 0.75). Test hook; production reads from
   *  userSettings.compaction.proactiveThresholdPct (M6-05). */
  proactiveCompactThreshold?: number;
```

In `Runtime`:

```typescript
  /** Resolved fraction of provider context length above which
   *  shouldCompactProactively returns true. Always populated; default
   *  matches shouldCompactProactively's built-in default (0.75 at the
   *  time of writing — read src/compact/compactor.ts to confirm). */
  proactiveCompactThreshold: number;
```

In `buildRuntime` (after `microcompactConfig` construction):

```typescript
  const proactiveCompactThreshold =
    options.proactiveCompactThreshold ??
    userSettings.compaction?.proactiveThresholdPct ??
    0.75;
```

> If `userSettings.compaction?.proactiveThresholdPct` doesn't exist on the schema, omit that fallback layer and default directly to `0.75`. Read `src/config/schema.ts` first.

In the return object: `proactiveCompactThreshold,`.

- [ ] **Step 3: Add `compaction_complete` to the SSE event union**

In `src/server/eventBus.ts` (or the types file the union lives in), add to the discriminated union:

```typescript
export type CompactionCompleteEvent = {
  type: 'compaction_complete';
  seq: number;
  sessionId: string; // parent (the id the client was subscribed to)
  activeSessionId: string; // new id for subsequent POSTs
  summary: string;
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
};
```

Add `CompactionCompleteEvent` to whatever union name is used (likely `ServerEvent`).

- [ ] **Step 4: Wire the proactive check into `runTurnInBackground`**

In `src/server/routes/turns.ts`, inside `runTurnInBackground`, AFTER building/hydrating `messages` and BEFORE the `query({...})` call:

```typescript
  // Proactive compaction: if the hydrated history + system prompt exceeds
  // the threshold, compact before the turn. Mirrors terminalRepl.ts:1333-1348.
  if (
    shouldCompactProactively({
      messages,
      systemPrompt: runtime.systemSegments,
      contextLength: runtime.resolvedProvider.metadata?.contextLength ?? Infinity,
      threshold: runtime.proactiveCompactThreshold,
    })
  ) {
    const result = await runtime.compact(messages, sessionId, bus.abortSignal);
    bus.publish({
      type: 'compaction_complete',
      seq: bus.nextSeq(),
      sessionId, // parent
      activeSessionId: result.newSessionId,
      summary: result.summary,
      estimatedBeforeTokens: result.estimatedBeforeTokens,
      estimatedAfterTokens: result.estimatedAfterTokens,
    });
    sessionId = result.newSessionId; // hop to child for the rest of the turn
    messages = [...result.tail];
  }
```

> Implementer: `sessionId` must be `let` not `const` for the reassignment to work. If currently `const`, change it. The `messages` variable similarly. Wrap `bus.publish` correctly per the existing seq-allocation pattern (look for `bus.nextSeq()` usage elsewhere in the file).

Add the import at the top:

```typescript
import { shouldCompactProactively } from '../../compact/compactor.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/server/turns.proactiveCompact.test.ts`
Expected: PASS — `compaction_complete` fires before `text_delta`; lineage row is recorded.

- [ ] **Step 6: Run the full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/server/runtime.ts src/server/routes/turns.ts src/server/eventBus.ts tests/server/turns.proactiveCompact.test.ts
git commit -m "$(cat <<'EOF'
feat(server): M6 T3 — proactive compaction check in turns route

shouldCompactProactively check fires before query() in runTurnInBackground.
On true, runs runtime.compact, emits compaction_complete SSE event, hops
sessionId to the new child for the rest of the turn. Mirrors terminalRepl.ts:1333-1348.
EOF
)"
```

---

## Task 4: Context-overflow auto-recovery in `runTurnInBackground`

**Goal:** Wrap the `query()` iteration in try/catch. When a `Terminal` carries `isContextOverflowError(terminal.error) === true` OR a thrown error from the iteration is an overflow, run `runtime.compact(...)`, emit `compaction_complete`, and re-enter the iteration loop ONCE against the new session id. A second overflow surfaces as `turn_error` (no further retry). Closes prereq row 15.

**Files:**
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.overflowRecovery.test.ts`

**Spec / inventory pointers:**
- `src/providers/errors.ts:81` — `isContextOverflowError`
- `src/ui/terminalRepl.ts:1659-1675` — overflow recovery reference

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.overflowRecovery.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { ContextOverflowError } from '../../src/providers/errors.js';

describe('turns route — context-overflow auto-recovery', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t4-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('overflow on first call → compact → retry → second call succeeds', async () => {
    let callCount = 0;
    const provider = new MockProvider({
      streamFn: async function* (_req) {
        callCount++;
        if (callCount === 1) {
          throw new ContextOverflowError('context too long');
        }
        yield { type: 'text_delta', delta: 'recovered response' };
        yield { type: 'message_stop' };
      },
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const bus = new ServerEventBus();
    const events: { type: string }[] = [];
    bus.subscribe((evt) => events.push({ type: evt.type }));

    await runTurnInBackground({ runtime, sessionId, bus, userText: 'hello' });

    const types = events.map((e) => e.type);
    expect(types).toContain('compaction_complete');
    expect(types).toContain('turn_complete');
    expect(types).not.toContain('turn_error');

    // Lineage recorded once
    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);

    await runtime.dispose();
  });

  test('second overflow → turn_error, no further retry', async () => {
    const provider = new MockProvider({
      streamFn: async function* (_req) {
        throw new ContextOverflowError('still too long');
      },
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const bus = new ServerEventBus();
    const events: { type: string }[] = [];
    bus.subscribe((evt) => events.push({ type: evt.type }));

    await runTurnInBackground({ runtime, sessionId, bus, userText: 'hello' });

    const types = events.map((e) => e.type);
    expect(types).toContain('turn_error');

    await runtime.dispose();
  });
});
```

> NOTE for implementer: `MockProvider`'s `streamFn` injection point may not exist; use the cleanest existing extension hook (script with throws, or extend the mock). The test intent is what matters — first call throws overflow, second call streams successfully.

- [ ] **Step 2: Refactor `runTurnInBackground` to support retry**

The simplest shape: extract the `query()` invocation + iteration loop into an inner function `runOnce(messages, sessionId): Promise<{ ok: true } | { ok: false, overflow: boolean, error: unknown }>`. On `ok: false` and `overflow: true`, the outer code performs compaction + retries `runOnce` once.

In `src/server/routes/turns.ts`, restructure the existing try/catch (around lines 166-262) along these lines:

```typescript
  const runOnce = async (
    iterMessages: Message[],
    iterSessionId: string,
  ): Promise<{ ok: true } | { ok: false; overflow: boolean; error: unknown }> => {
    try {
      const stream = query({
        provider: runtime.resolvedProvider.transport,
        model: runtime.model,
        messages: iterMessages,
        systemPrompt: runtime.systemSegments,
        tools: runtime.toolPool,
        toolContext: buildSessionToolContext(runtime, iterSessionId, sessionCanUseTool),
        maxTokens: runtime.maxTokens,
        sessionId: iterSessionId,
        cwd: runtime.cwd,
        signal: bus.abortSignal,
        canUseTool: sessionCanUseTool,
        hookRunner: runtime.hookRunner,
        microcompactConfig: runtime.microcompactConfig,
      });

      const currentBlock = 0;
      const pendingToolUses = new Map<string, PendingToolUse>();
      let terminalEmitted = false;

      while (true) {
        const result = await stream.next();
        if (result.done) {
          const terminal: Terminal | undefined = result.value;
          if (terminal?.error && isContextOverflowError(terminal.error)) {
            return { ok: false, overflow: true, error: terminal.error };
          }
          if (!bus.isClosed() && !terminalEmitted) {
            bus.publish({
              type: 'turn_complete',
              seq: bus.nextSeq(),
              sessionId: iterSessionId,
              finishReason: mapTerminalReason(terminal),
            });
            terminalEmitted = true;
          }
          return { ok: true };
        }
        const event = result.value;
        // ... (existing user-message + assistant-message + mapped-event handling, unchanged) ...
      }
    } catch (err) {
      if (isContextOverflowError(err)) {
        return { ok: false, overflow: true, error: err };
      }
      return { ok: false, overflow: false, error: err };
    }
  };

  // First attempt
  let attempt = await runOnce(messages, sessionId);

  // Single overflow retry (M6-02)
  if (!attempt.ok && attempt.overflow) {
    try {
      const result = await runtime.compact(messages, sessionId, bus.abortSignal);
      bus.publish({
        type: 'compaction_complete',
        seq: bus.nextSeq(),
        sessionId,
        activeSessionId: result.newSessionId,
        summary: result.summary,
        estimatedBeforeTokens: result.estimatedBeforeTokens,
        estimatedAfterTokens: result.estimatedAfterTokens,
      });
      sessionId = result.newSessionId;
      messages = [...result.tail];
      attempt = await runOnce(messages, sessionId);
    } catch (compactErr) {
      bus.publish({
        type: 'turn_error',
        seq: bus.nextSeq(),
        sessionId,
        error: compactErr instanceof Error ? compactErr.message : String(compactErr),
        recoverable: false,
      });
      return;
    }
  }

  if (!attempt.ok) {
    bus.publish({
      type: 'turn_error',
      seq: bus.nextSeq(),
      sessionId,
      error: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
      recoverable: false,
    });
  }
```

Add at the top of the file:

```typescript
import { isContextOverflowError } from '../../providers/errors.js';
```

> Implementer note: the inner-function pattern is the cleanest way to keep "iterate then maybe retry" readable. The full body above elides the existing event-handling logic for brevity — preserve every line of it inside the inner function. Don't lose the `assistant_message` special-case or the `handleUserMessage` call.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `bun test tests/server/turns.overflowRecovery.test.ts`
Expected: both tests PASS.

- [ ] **Step 4: Run the full suite (regression check)**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green. The refactor of the iteration loop is the highest-risk change in this task — pay attention to any pre-existing turn-test failures.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/turns.ts tests/server/turns.overflowRecovery.test.ts
git commit -m "$(cat <<'EOF'
feat(server): M6 T4 — context-overflow auto-recovery in turns route

Wraps query() iteration in runOnce() inner function. On
isContextOverflowError (from Terminal.error or thrown), runs
runtime.compact, emits compaction_complete, retries the turn ONCE against
the new session id (M6-02). Second overflow surfaces as turn_error.
Mirrors terminalRepl.ts:1659-1675. Closes prereq row 15.
EOF
)"
```

---

## Task 5: `POST /sessions/:id/compact` route

**Goal:** Expose explicit compaction as a synchronous HTTP verb (M6-03). The route reads the session's history from `sessionDb`, calls `runtime.compact(...)`, and returns the JSON result. 404 for unknown session id. Mounted on the Hono app. Closes the explicit-compaction half of prereq row 7.

**Files:**
- Create: `src/server/routes/compact.ts`
- Modify: `src/server/app.ts`
- Create: `tests/server/routes/compact.test.ts`

**Spec / inventory pointers:**
- `src/server/routes/approvals.ts` — M5 reference for synchronous-route shape
- `src/server/routes/turns.ts` — reference for how routes read `sessionDb` + `runtime`
- `src/agent/sessionDb.ts` — `getMessages(sessionId)` for reading history; `createSession` semantics for the new child id

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/compact.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../../src/server/runtime.js';
import { MockProvider } from '../../../src/providers/mock.js';
import { buildApp } from '../../../src/server/app.js';

describe('POST /sessions/:id/compact', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t5-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('returns activeSessionId + summary on a valid session', async () => {
    const provider = new MockProvider({
      script: [{ kind: 'text', text: 'Summary text.' }],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
    });
    const app = buildApp(runtime);

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    runtime.sessionDb.saveMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });

    const response = await app.request(`/sessions/${sessionId}/compact`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeSessionId).toBeDefined();
    expect(body.activeSessionId).not.toBe(sessionId);
    expect(typeof body.summary).toBe('string');
    expect(body.estimatedBeforeTokens).toBeGreaterThanOrEqual(0);
    expect(body.estimatedAfterTokens).toBeGreaterThanOrEqual(0);

    await runtime.dispose();
  });

  test('returns 404 for unknown session id', async () => {
    const provider = new MockProvider({ script: [] });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
    });
    const app = buildApp(runtime);

    const response = await app.request('/sessions/00000000-0000-0000-0000-000000000000/compact', {
      method: 'POST',
    });
    expect(response.status).toBe(404);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/routes/compact.test.ts`
Expected: FAIL — route is not mounted; 404 on the success path too.

- [ ] **Step 3: Create `src/server/routes/compact.ts`**

```typescript
import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';
import { SessionNotFoundError } from '../errors.js';

export function compactRoute(runtime: Runtime): Hono {
  const app = new Hono();

  app.post('/sessions/:id/compact', async (c) => {
    const sessionId = c.req.param('id');
    const session = runtime.sessionDb.getSession(sessionId);
    if (!session) {
      return c.json({ error: 'session not found', sessionId }, 404);
    }

    const messages = runtime.sessionDb.getMessages(sessionId);
    const result = await runtime.compact(messages, sessionId, c.req.raw.signal);

    return c.json({
      activeSessionId: result.newSessionId,
      summary: result.summary,
      estimatedBeforeTokens: result.estimatedBeforeTokens,
      estimatedAfterTokens: result.estimatedAfterTokens,
      usedAuxiliary: result.usedAuxiliary,
    });
  });

  return app;
}
```

> Implementer: confirm `runtime.sessionDb.getSession` and `getMessages` are the right method names by reading `src/agent/sessionDb.ts`. Adjust if the API uses different names (e.g., `getSessionRow` or `loadMessages`). The error class import path may also differ — check `src/server/errors.ts`.

- [ ] **Step 4: Mount the route in `src/server/app.ts`**

Find the existing `buildApp` (or equivalent app-construction function) and add:

```typescript
import { compactRoute } from './routes/compact.js';
// ...
app.route('/', compactRoute(runtime));
```

> Match the existing mount pattern (whatever the M5 approvals route uses).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/server/routes/compact.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Run the full suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/compact.ts src/server/app.ts tests/server/routes/compact.test.ts
git commit -m "$(cat <<'EOF'
feat(server): M6 T5 — POST /sessions/:id/compact synchronous route

Synchronous /compact verb (M6-03) — reads session history, calls
runtime.compact, returns { activeSessionId, summary, estimatedBeforeTokens,
estimatedAfterTokens, usedAuxiliary }. 404 on unknown session id. Closes
the explicit-compaction half of prereq row 7.
EOF
)"
```

---

## Task 6: TUI `/compact` dispatch + `compaction_complete` handling

**Goal:** Two Go-side changes:
1. Intercept the `/compact` user input client-side: POST to `/sessions/<currentId>/compact`, render a transcript marker on success, update `m.sessionID` from the response so subsequent turns route to the new session.
2. Handle the `compaction_complete` SSE event (from proactive + overflow paths): render a transcript marker, update `m.sessionID`.

**Files:**
- Modify: `packages/tui/internal/app/app.go`
- Modify: `packages/tui/internal/transport/api.go`

**Spec / inventory pointers:**
- M5 T9 (`packages/tui/internal/components/permission.go`) — reference for the transport client + app handler pattern
- `packages/tui/internal/transport/api.go` — existing client (M5 added `PostApproval`)

- [ ] **Step 1: Add `PostCompact` to the transport client**

In `packages/tui/internal/transport/api.go`:

```go
type CompactResponse struct {
    ActiveSessionID         string `json:"activeSessionId"`
    Summary                 string `json:"summary"`
    EstimatedBeforeTokens   int    `json:"estimatedBeforeTokens"`
    EstimatedAfterTokens    int    `json:"estimatedAfterTokens"`
    UsedAuxiliary           bool   `json:"usedAuxiliary"`
}

func PostCompact(ctx context.Context, baseURL string, sessionID string) (*CompactResponse, error) {
    url := fmt.Sprintf("%s/sessions/%s/compact", baseURL, sessionID)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
    if err != nil {
        return nil, err
    }
    client := &http.Client{Timeout: 60 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("compact: server returned %d", resp.StatusCode)
    }
    var out CompactResponse
    if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
        return nil, err
    }
    return &out, nil
}
```

> Implementer: copy the import block + helper conventions from the existing `PostApproval` shape. Adjust the timeout if the existing client uses a constant.

- [ ] **Step 2: Add a Bubble Tea command for `/compact`**

In `packages/tui/internal/app/app.go`, add a command + message:

```go
type compactRequestedMsg struct{}
type compactCompleteMsg struct {
    activeSessionID string
    summary         string
}
type compactErrorMsg struct {
    err error
}

func (m model) compactCmd() tea.Cmd {
    return func() tea.Msg {
        ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
        defer cancel()
        resp, err := transport.PostCompact(ctx, m.baseURL, m.sessionID)
        if err != nil {
            return compactErrorMsg{err: err}
        }
        return compactCompleteMsg{activeSessionID: resp.ActiveSessionID, summary: resp.Summary}
    }
}
```

In `Update`:

```go
case compactRequestedMsg:
    m.transcript = append(m.transcript, "[compacting…]")
    return m, m.compactCmd()
case compactCompleteMsg:
    m.sessionID = msg.activeSessionID
    m.transcript = append(m.transcript, fmt.Sprintf("[compacted — new session %s]", msg.activeSessionID[:8]))
    return m, nil
case compactErrorMsg:
    m.transcript = append(m.transcript, fmt.Sprintf("[compact failed: %v]", msg.err))
    return m, nil
```

In the input-submit handler (where the user presses Enter), add the `/compact` interception BEFORE the POST /turns dispatch:

```go
if strings.TrimSpace(submitted) == "/compact" {
    return m, func() tea.Msg { return compactRequestedMsg{} }
}
```

- [ ] **Step 3: Handle `compaction_complete` SSE events**

In the SSE event handler in `app.go` (where `permission_request`, `text_delta`, etc. are dispatched):

```go
case "compaction_complete":
    var evt struct {
        ActiveSessionID       string `json:"activeSessionId"`
        Summary               string `json:"summary"`
        EstimatedBeforeTokens int    `json:"estimatedBeforeTokens"`
        EstimatedAfterTokens  int    `json:"estimatedAfterTokens"`
    }
    if err := json.Unmarshal(rawEvent.Data, &evt); err == nil {
        m.sessionID = evt.ActiveSessionID
        m.transcript = append(m.transcript,
            fmt.Sprintf("[auto-compacted — %d→%d tokens — new session %s]",
                evt.EstimatedBeforeTokens, evt.EstimatedAfterTokens, evt.ActiveSessionID[:8]))
    }
```

> Implementer: match the exact unmarshal pattern used elsewhere in `app.go` (the M3 `text_delta` handler is the simplest reference). The transcript marker is intentionally minimal — M9 owns visual polish.

- [ ] **Step 4: Run Go tests**

Run: `cd packages/tui && go test ./...`
Expected: all green. There is no new Go-side unit test in T6; the integration smoke in T7 exercises this path end-to-end.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/internal/app/app.go packages/tui/internal/transport/api.go
git commit -m "$(cat <<'EOF'
feat(tui): M6 T6 — /compact dispatch + compaction_complete handling

Adds PostCompact transport helper. /compact user input is intercepted
client-side and POSTed to /sessions/:id/compact; on success the active
session id hops to the response's activeSessionId. compaction_complete
SSE events (from proactive + overflow paths) update the session id and
render a minimal transcript marker (M6-01). Visual polish deferred to M9.
EOF
)"
```

---

## Task 7: Integration smoke + close-out

**Goal:** Three end-to-end scenarios in the existing tuiLauncher integration test exercise: (a) microcompact event fires through the launcher, (b) proactive compaction completes through the launcher, (c) overflow-then-retry completes through the launcher. Three prereq boxes flip (rows 7, 8, 15). ADR stubs added. New state snapshot supersedes `2026-05-14.md`. CLAUDE.md / AGENTS.md pointers updated. Final `bun run lint && bun run typecheck && bun run test` + push.

**Files:**
- Modify: `tests/cli/tuiLauncherIntegration.test.ts`
- Modify: `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`
- Modify: `DECISIONS.md`
- Modify: `CLAUDE.md`, `AGENTS.md`
- Create: `docs/07-history/state/2026-05-XX.md` (today's date if M6 lands today, else the close-out date)

- [ ] **Step 1: Extend the integration smoke**

In `tests/cli/tuiLauncherIntegration.test.ts`, add a `describe('M6 — long-session survival', ...)` block with three tests mirroring the unit-test scenarios from T1, T3, T4 — but driving them through `runTuiLauncher` (real `buildRuntime`, real Hono server on a free port, mock spawn). Reference the M5 block for the integration shape.

```typescript
describe('M6 — long-session survival', () => {
  test('microcompact event fires through tuiLauncher', async () => {
    // Same arrangement as tests/server/turns.microcompact.test.ts but
    // launched via runTuiLauncher with mock spawn parking the child.
    // Assert: the captured event log includes 'microcompact'.
  });

  test('proactive compaction completes through tuiLauncher', async () => {
    // Pre-populate session history that exceeds threshold; assert
    // 'compaction_complete' event observed; assert lineage row.
  });

  test('overflow-then-retry completes through tuiLauncher', async () => {
    // Mock provider throws overflow on first call, succeeds on second;
    // assert 'compaction_complete' + 'turn_complete' both observed.
  });
});
```

> Each test is a near-copy of the unit-test arrangement from T1/T3/T4. The smoke value is asserting the path survives the full launcher → buildRuntime → Hono → query() flow.

- [ ] **Step 2: Run the extended smoke**

Run: `bun test tests/cli/tuiLauncherIntegration.test.ts`
Expected: all M4 + M5 + M6 scenarios PASS.

- [ ] **Step 3: Flip three prereq boxes**

In `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`:

- Row 7 (Compactor): `[ ]` → `[x]` with `(M6 — 2026-05-XX)` annotation
- Row 8 (Microcompaction): `[ ]` → `[x]` with `(M6 — 2026-05-XX)` annotation
- Row 15 (Context-overflow auto-recovery): `[ ]` → `[x]` with `(M6 — 2026-05-XX)` annotation

Update the document's header summary line ("21 boxes remain `[ ]`" → "18 boxes remain `[ ]`" — verify against the current state).

- [ ] **Step 4: Add ADR stubs**

In `DECISIONS.md`, append three rows:

- M6-01: Compaction creates new session id; client tracks it via `compaction_complete` SSE event + `POST /compact` response
- M6-02: Single retry on context-overflow; second overflow surfaces as `turn_error`
- M6-03: `POST /sessions/:id/compact` is synchronous; returns the `CompactResult` JSON inline

Use the existing ADR stub format in the file (one-line title + brief rationale).

- [ ] **Step 5: Write the close-out state snapshot**

Create `docs/07-history/state/2026-05-XX.md` (today's date, or the close-out date if M6 spans into the next day) using `docs/07-history/state/2026-05-14.md` as the template. Required sections:

- HEAD SHA + suite count + lint/typecheck status
- Where we are (M6 closed; 18 boxes remain)
- What shipped today (T1–T7 commit SHAs)
- Phases shipped (M6 — long-session survival)
- Tasks 1–7 in detail
- What does NOT work / known gaps for M7+ (compaction visual polish in M9; auxiliary cheap-model selection in Phase 15 / M8; multi-retry policy if user demand surfaces)
- Behavioral notes worth knowing next session (session-id swap on compact; TUI hops `m.sessionID`; one-retry overflow contract)
- What's open / what's next (M7 Hermes-layer parity — 6 boxes)
- Manual smoke — pending the user (3 scenarios: explicit `/compact` works through TUI; proactive fires after sustained turn count exceeds threshold; overflow on a real provider triggers recovery)

Then move `docs/07-history/state/2026-05-14.md` → `docs/07-history/state/archive/2026-05-14.md` (or whatever the existing archive convention requires — verify by reading the `docs/07-history/state/archive/` directory).

- [ ] **Step 6: Update `CLAUDE.md` + `AGENTS.md` state-snapshot pointer**

Both files reference `docs/07-history/state/2026-05-14.md` in the session-boot list and the doc-index table. Update both to the new dated file. After editing both, verify byte-identical mirror:

```bash
diff CLAUDE.md AGENTS.md
```

Expected: no output (files identical).

- [ ] **Step 7: Run the full pre-commit gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green.

Run: `cd packages/tui && go test ./...`
Expected: all green.

- [ ] **Step 8: Append testing-log entry**

In `docs/06-testing/testing-log.md`, prepend (newest-first) a 2026-05-XX entry covering: M6 build pass; the three new unit-test files; the integration-smoke extension; suite delta (1897 → 1897+N); any regressions caught + fixed during the build.

- [ ] **Step 9: Commit and run sov upgrade**

```bash
git add tests/cli/tuiLauncherIntegration.test.ts docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md DECISIONS.md docs/07-history/state/ CLAUDE.md AGENTS.md docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
docs: M6 close-out — long-session survival shipped

Three prereq boxes flipped (rows 7, 8, 15). M6-01/02/03 ADRs landed.
State snapshot supersedes 2026-05-14. CLAUDE/AGENTS pointer updated;
byte-identical mirror preserved. Integration smoke extends with three
M6 scenarios.
EOF
)"
git push origin master
sov upgrade
```

> `sov upgrade` is required because M6 touched `src/` and `packages/tui/`. See `docs/05-conventions/sov-upgrade.md`.

---

## Self-review checklist (run before declaring the plan ready)

1. **Spec coverage** — does every M6 spec exit criterion map to a task? (`/compact` works → T5; threshold-triggered compaction → T3; microcompaction → T1; context-overflow → `createClearedChildSession` → T4 via runtime.compact, which uses `compactSession` which internally uses `createClearedChildSession`. Verify by reading `src/compact/compactor.ts` — if `compactSession` does NOT internally call `createClearedChildSession`, T4 needs an explicit reference to it.)
2. **Placeholder scan** — every "Step N" contains either runnable code, an exact command, or a documented decision. No "TBD" / "implement later".
3. **Type consistency** — `MicrocompactConfig` (T1) / `ServerCompactor` (T2) / `CompactionCompleteEvent` (T3) / `CompactResponse` (T6) names appear identically across tasks.
4. **Sub-skill pointer** — header's `superpowers:subagent-driven-development` reference is the right one for this plan.
5. **Prereq box numbers** — rows 7, 8, 15 verified against `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` at plan-write time.
