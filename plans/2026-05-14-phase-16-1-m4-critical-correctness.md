# Phase 16.1 M4 — Critical Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three M4 critical-correctness subsystems through `--ui tui` — persistent on-disk session DB, provider/tool preflight checks at boot, and CLI flag forwarding so every M4-wired flag accepted by `sov` reaches the new TUI surface with identical semantics.

**Architecture:** Extend `RuntimeOptions` and `buildRuntime` (`src/server/runtime.ts`) to accept `dbPath`, `resumeId`, `maxTokens`, `preflight` (already has `cacheEnabled` + `permissionMode`). On disk path, open a real SQLite file under `harnessHome` (default) or user-supplied path, run `cleanupPhantomReviews()` and `preflightProvider()` (+ `preflightToolCalling()` for Ollama) at boot, and validate any `resumeId` against `sessionDb.getSession()` before returning. Add `GET /sessions/:id/messages` so the Go TUI can hydrate prior transcript on resume. Persist every user / assistant / tool_result message in `runTurnInBackground` via `sessionDb.saveMessage`. Update `tuiLauncher` to forward all M4-supported flags into `buildRuntime`, warn explicitly when a flag's downstream subsystem lands in a later milestone, and hard-error on `--legacy-input --ui tui` (REPL-only). `terminalRepl.ts` is untouched per Postmortem Rule 1.

**Tech Stack:** TypeScript (Bun, strict), Hono 4.x, `bun:sqlite` via `SessionDb`, Zod (existing `ServerEventSchema`), Go 1.24 (Bubble Tea, `lipgloss`, `bubbles`).

**Spec references:**
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §9, §10 (M4 row)
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` rows 6 (Session DB persistence), 9 (Preflight checks), 23 (Full CLI flag forwarding)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4 (terminalRepl untouched; coexistence; audit-before-flip)
- `docs/07-history/state/archive/2026-05-13.md` — M3 close-out (HEAD `2287a03` at plan time)

**Scope guard — what M4 does NOT do:**
- No interactive permission modal (M5). The `ask()` deny placeholder in `buildRuntime` stays.
- No transcript writer, no capture/replay (M7/M8). Flags accepted but warn-and-drop.
- No agent / state-dir / scheduled-mission wiring (M7). Flags accepted but warn-and-drop.
- No `--verbose` behavior change (M9 visual polish owns presentation).
- No `--legacy-input` support — REPL-only by definition; hard error.
- No default flip; `--ui tui` stays opt-in through M11.

---

## Files Touched

**TypeScript (server / launcher):**
- `src/server/runtime.ts` — extend `RuntimeOptions`, on-disk SessionDb, cleanupPhantomReviews, preflight, resume validation. Add `maxTokens` field to `Runtime`.
- `src/server/routes/turns.ts` — consume `runtime.maxTokens` instead of `DEFAULT_MAX_TOKENS`; persist user/assistant/tool_result messages via `runtime.sessionDb.saveMessage`.
- `src/server/routes/sessions.ts` — add `GET /sessions/:id/messages` returning the message backlog.
- `src/server/index.ts` — mount the new messages route in `buildApp`.
- `src/cli/tuiLauncher.ts` — extend `TuiLaunchOptions`, forward every M4-supported flag, warn-or-error on deferred/incompatible flags. Catch preflight + resume errors with user-friendly text.

**Go (TUI client):**
- `packages/tui/internal/transport/types.go` — add `Message` shape + decoder for the new `GET /sessions/:id/messages` response.
- `packages/tui/internal/transport/http.go` (new) — `FetchMessages(ctx, baseURL, sessionID)` helper.
- `packages/tui/internal/app/app.go` — on `Init()`, fetch messages and populate transcript before subscribing to SSE.
- `packages/tui/internal/components/transcript.go` — add `AppendStoredMessages` helper if not already present.

**Tests:**
- `tests/server/runtime.test.ts` — new cases for disk path, resume validation, preflight invocation, maxTokens echo, cleanupPhantomReviews.
- `tests/server/routes/sessions.test.ts` (rename from `sessions.test.ts` if needed) — new `/sessions/:id/messages` cases.
- `tests/server/turns.test.ts` — new cases for message persistence + `runtime.maxTokens` plumbing.
- `tests/cli/tuiLauncher.test.ts` — new integration-style test with mocked `spawn` + `startServer` that asserts buildRuntime receives forwarded flags; deferred-flag warning; legacy-input error.
- `packages/tui/internal/app/app_test.go` — case for fetching + rendering message backlog on `Init()`.
- `packages/tui/internal/transport/http_test.go` (new) — `FetchMessages` decode test.

**Docs:**
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` — flip the three M4 checkboxes to `[x]`.
- `docs/03-cli-reference/usage.md` — add an "ui tui flag coverage" table.
- `docs/06-testing/testing-log.md` — append M4 close-out entry.
- `docs/07-history/state/2026-05-14.md` (new) — M4 close-out snapshot, supersedes 2026-05-13.
- `CLAUDE.md`, `AGENTS.md` — bump the "most recent close-out snapshot" pointer.
- `DECISIONS.md` — short ADR for the `GET /sessions/:id/messages` hydrate-then-subscribe pattern.

---

## Task 1 — On-disk SessionDb + phantom cleanup in `buildRuntime`

**Files:**
- Modify: `src/server/runtime.ts:34-54` (RuntimeOptions), `:124-128` (sessionDb open), `:174-191` (return)
- Test: `tests/server/runtime.test.ts`

Replace the hardcoded `:memory:` open with a real on-disk DB. Add `dbPath?: string` to `RuntimeOptions`; when omitted, fall through to `getDefaultDbPath()` (the same default `terminalRepl` uses via `SessionDb.open({})`). Run `cleanupPhantomReviews()` immediately after open and write a one-line stderr notice when count > 0, matching `terminalRepl.ts:402-405`.

- [ ] **Step 1: Write the failing tests**

Add three cases to `tests/server/runtime.test.ts`:

```typescript
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — Task 1 — on-disk SessionDb', () => {
  test('opens sessionDb at opts.dbPath when supplied', async () => {
    const home = join(tmpdir(), `m4-task1-${Date.now()}`);
    const dbPath = join(home, 'custom.db');
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      dbPath,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      expect(runtime.sessionDb.getSession(sessionId)?.sessionId).toBe(sessionId);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to harnessHome/sessions.db when dbPath omitted', async () => {
    const home = join(tmpdir(), `m4-task1b-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      // Smoke check: sessionDb is wired and writes succeed against a real file.
      const id = runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('runs cleanupPhantomReviews at boot', async () => {
    const home = join(tmpdir(), `m4-task1c-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      // No assertions on count — the DB is fresh and has zero phantoms. The
      // test pins that cleanupPhantomReviews() is reachable (no throw) at
      // boot. Failure mode is a typo / wrong API surface, not a count.
      expect(runtime.sessionDb.cleanupPhantomReviews()).toBe(0);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/runtime.test.ts`
Expected: 3 failures — either `RuntimeOptions does not include 'dbPath'` (typecheck) or — once dbPath is added but the open stays `:memory:` — first test fails because `runtime.sessionDb` is not file-backed (write-then-read against a separate open at the path would surface this, but we exercise via getSession on the same instance which still passes; the real failing assertion in test 1 is the `getSession?.sessionId` check, which DOES pass against `:memory:`).

If test 1 passes against `:memory:`, strengthen the assertion: open a second `SessionDb` against the same `dbPath` after `dispose()` and verify the row is visible there. Use the actual `SessionDb.open({ path: dbPath })` import. This pins the persistence semantics correctly.

Rewrite test 1's body with the second-open assertion:

```typescript
test('opens sessionDb at opts.dbPath when supplied (persists across opens)', async () => {
  const home = join(tmpdir(), `m4-task1-${Date.now()}`);
  const dbPath = join(home, 'custom.db');
  const runtime = await buildRuntime({
    cwd: process.cwd(),
    provider: 'mock',
    harnessHome: home,
    dbPath,
  });
  const sessionId = runtime.sessionDb.createSession({
    model: 'mock',
    provider: 'mock',
    systemPrompt: [],
    metadata: {},
  });
  await runtime.dispose();
  try {
    const { SessionDb } = await import('../../src/agent/sessionDb.js');
    const reopened = SessionDb.open({ path: dbPath });
    try {
      expect(reopened.getSession(sessionId)?.sessionId).toBe(sessionId);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

Re-run: `bun test tests/server/runtime.test.ts`
Expected: the rewritten test 1 now fails against `:memory:` because the reopened DB is empty.

- [ ] **Step 3: Implement**

Edit `src/server/runtime.ts`:

```typescript
// In RuntimeOptions (insert after `permissionMode?: PermissionMode;`):
  /** Explicit session DB path override. When omitted, opens at
   *  <harnessHome>/sessions.db — the same default terminalRepl uses. */
  dbPath?: string;
```

```typescript
// Replace lines 124-128 with:
  // On-disk session DB. terminalRepl opens the same DB at
  // <harnessHome>/sessions.db by default; the --db CLI flag overrides
  // both surfaces identically (Postmortem Rule 1: parity, not parallel
  // semantics). cleanupPhantomReviews sweeps stale review-fork rows
  // from prior session crashes; mirrors terminalRepl.ts:402-405.
  const sessionDb =
    opts.dbPath !== undefined
      ? SessionDb.open({ path: opts.dbPath })
      : SessionDb.open({});
  const phantomsCleaned = sessionDb.cleanupPhantomReviews();
  if (phantomsCleaned > 0) {
    process.stderr.write(
      `[review] cleaned up ${phantomsCleaned} phantom review row(s)\n`,
    );
  }
```

The `SessionDb.open({})` default uses `getDefaultDbPath()` which respects `$HARNESS_HOME` — `resolveHarnessHome()` ran 7 lines earlier and `mkdirSync`'d `harnessHome` already, so the parent dir exists. No additional `ensureParentDir` call needed because `SessionDb.open` does it internally for non-`:memory:` paths.

When `opts.harnessHome` is set (test isolation), the SessionDb default path follows `$HARNESS_HOME` if it's exported in the test, but tests run in-process so the env var isn't mutated. For test isolation, tests should always pass an explicit `dbPath`. The second test in Step 1 (`falls back to harnessHome/sessions.db when dbPath omitted`) actually exercises the production default — needs a guard. Tighten that test:

```typescript
test('falls back to <harnessHome>/sessions.db when dbPath omitted', async () => {
  const home = join(tmpdir(), `m4-task1b-${Date.now()}`);
  const prevEnv = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      expect(existsSync(join(home, 'sessions.db'))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  } finally {
    if (prevEnv === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prevEnv;
    rmSync(home, { recursive: true, force: true });
  }
});
```

Add `import { existsSync } from 'node:fs';` to the test file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/server/runtime.test.ts`
Expected: all 3 new cases pass; pre-existing cases (permission cascade tests at line 12+) still pass.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime.ts tests/server/runtime.test.ts
git commit -m "feat(server): buildRuntime opens on-disk SessionDb + cleanupPhantomReviews

M4 Task 1 — RuntimeOptions gains dbPath; falls back to harnessHome/sessions.db
when omitted (matches terminalRepl default). cleanupPhantomReviews sweeps
stale review-fork rows at boot. M3 :memory: store is gone; sessions now
survive process exit."
```

---

## Task 2 — Resume validation in `buildRuntime`

**Files:**
- Modify: `src/server/runtime.ts:34-54` (RuntimeOptions), `:174-191` (return), error class
- Create: `src/server/errors.ts` (new — error classes for buildRuntime failures)
- Test: `tests/server/runtime.test.ts`

When `opts.resumeId` is supplied, validate it exists in `sessionDb` and throw `SessionNotFoundError` if not. Echo the resolved `resumeId` on the `Runtime` so downstream consumers (events route, future Task 3 messages route) know whether to hydrate prior history.

- [ ] **Step 1: Write the failing tests**

Add to `tests/server/runtime.test.ts`:

```typescript
describe('buildRuntime — Task 2 — resume validation', () => {
  test('with valid resumeId, returns runtime with resumeId echoed', async () => {
    const home = join(tmpdir(), `m4-task2a-${Date.now()}`);
    const dbPath = join(home, 'sessions.db');
    // Seed a session in a sibling DB instance, then open via buildRuntime.
    const { SessionDb } = await import('../../src/agent/sessionDb.js');
    const seed = SessionDb.open({ path: dbPath });
    const seededId = seed.createSession({
      model: 'mock',
      provider: 'mock',
      systemPrompt: [],
      metadata: {},
    });
    seed.close();

    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      dbPath,
      resumeId: seededId,
    });
    try {
      expect(runtime.resumeId).toBe(seededId);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('with unknown resumeId, throws SessionNotFoundError', async () => {
    const home = join(tmpdir(), `m4-task2b-${Date.now()}`);
    try {
      await expect(
        buildRuntime({
          cwd: process.cwd(),
          provider: 'mock',
          harnessHome: home,
          resumeId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/session not found/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('without resumeId, runtime.resumeId is undefined', async () => {
    const home = join(tmpdir(), `m4-task2c-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      expect(runtime.resumeId).toBeUndefined();
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/runtime.test.ts`
Expected: typecheck error (`resumeId` not on `RuntimeOptions` / `Runtime`) or test failure once added but unimplemented.

- [ ] **Step 3: Implement**

Create `src/server/errors.ts`:

```typescript
// Error classes thrown by src/server/runtime.ts. Kept in a separate
// module so tests + tuiLauncher can `instanceof`-check without pulling
// in the full runtime boot transitive surface.

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}
```

Edit `src/server/runtime.ts`:

```typescript
// Add to RuntimeOptions, after dbPath:
  /** Resume a prior session by UUID. buildRuntime validates the row
   *  exists in sessionDb and throws SessionNotFoundError if not. */
  resumeId?: string;
```

```typescript
// Add to Runtime type, after permissionMode:
  /** Echoed resumeId from RuntimeOptions, validated against sessionDb
   *  at boot. Undefined when no resume requested. Downstream consumers
   *  (events route, /messages route) use this to decide whether to
   *  hydrate prior message history. */
  resumeId: string | undefined;
```

```typescript
// In the body, immediately after the sessionDb / cleanupPhantomReviews
// block from Task 1 and before the permission cascade:
  if (opts.resumeId !== undefined) {
    const existing = sessionDb.getSession(opts.resumeId);
    if (existing === null) {
      sessionDb.close();
      const { SessionNotFoundError } = await import('./errors.js');
      throw new SessionNotFoundError(opts.resumeId);
    }
  }
```

```typescript
// In the return object, add (alongside permissionMode):
    resumeId: opts.resumeId,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/server/runtime.test.ts`
Expected: all 6 cases (3 from Task 1 + 3 new) pass.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime.ts src/server/errors.ts tests/server/runtime.test.ts
git commit -m "feat(server): buildRuntime validates --resume against sessionDb

M4 Task 2 — RuntimeOptions gains resumeId; throws SessionNotFoundError
when row missing. Runtime.resumeId is echoed so downstream consumers know
whether to hydrate prior history. New src/server/errors.ts module so
tuiLauncher + tests can instanceof-check without pulling in the full
runtime."
```

---

## Task 3 — `GET /sessions/:id/messages` route

**Files:**
- Modify: `src/server/routes/sessions.ts`
- Test: `tests/server/sessions.test.ts` (or wherever the existing /sessions routes are tested — check first)

Add a GET route that returns the stored message backlog for a session. The Go TUI fetches this once on `Init()` before subscribing to SSE, hydrating the transcript. Hydrate-then-subscribe is cleaner than embedding the backlog in an SSE event because (a) it keeps the SSE stream lean for live events only, (b) HTTP fetch can be retried / paginated independently, (c) the wire-shape match with the existing `loadMessages()` SessionDb API is trivial.

- [ ] **Step 1: Locate existing sessions route tests**

Run: `ls tests/server/`
Expected: a `sessions.test.ts` exists (per the Explore agent's listing). Read its current shape to match the pattern.

Run: `bun test tests/server/sessions.test.ts -v 2>&1 | head -20`
Expected: see current test names (POST /sessions creates session, GET /sessions/:id returns metadata).

- [ ] **Step 2: Write the failing test**

Append to `tests/server/sessions.test.ts`:

```typescript
describe('GET /sessions/:id/messages — Task 3 — message backlog', () => {
  test('returns empty array for a freshly created session', async () => {
    const home = join(tmpdir(), `m4-task3a-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      const app = buildApp({ runtime });
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      const res = await app.request(`/sessions/${sessionId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: unknown[] };
      expect(body.messages).toEqual([]);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns persisted messages in time order', async () => {
    const home = join(tmpdir(), `m4-task3b-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
      });

      const app = buildApp({ runtime });
      const res = await app.request(`/sessions/${sessionId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.role).toBe('user');
      expect(body.messages[0]?.content[0]?.text).toBe('hello');
      expect(body.messages[1]?.role).toBe('assistant');
      expect(body.messages[1]?.content[0]?.text).toBe('hi back');
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 400 for invalid session id', async () => {
    const home = join(tmpdir(), `m4-task3c-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      const app = buildApp({ runtime });
      const res = await app.request('/sessions/not-a-uuid/messages');
      expect(res.status).toBe(400);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 404 for unknown session', async () => {
    const home = join(tmpdir(), `m4-task3d-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      const app = buildApp({ runtime });
      const res = await app.request(
        '/sessions/00000000-0000-0000-0000-000000000000/messages',
      );
      expect(res.status).toBe(404);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

Add imports as needed at the top of the file (`rmSync`, `join`, `tmpdir`, `buildApp`, `buildRuntime`) — match the pattern of the existing tests in the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/sessions.test.ts`
Expected: 4 new failures (route not yet mounted; 404 on every request).

- [ ] **Step 4: Implement**

Edit `src/server/routes/sessions.ts`. Add a new handler alongside the existing two:

```typescript
  r.get('/sessions/:id/messages', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
    const session = runtime.sessionDb.getSession(id);
    if (session === null) return c.json({ error: 'not found' }, 404);
    const stored = runtime.sessionDb.loadMessages(id);
    // Strip storage-internal fields (id, sessionId, createdAt, toolCalls,
    // tokenCount) — the TUI only needs role + content to render the
    // backlog. Future surfaces (HTTP API consumers in Phase 18) may
    // surface the full row but that's a separate route's concern.
    const messages = stored.map((m) => ({ role: m.role, content: m.content }));
    return c.json({ messages });
  });
```

Confirm `isValidSessionId` and `runtime` are already in scope at this point in the file (the existing POST + GET handlers reference both). No new imports needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/server/sessions.test.ts`
Expected: all 4 new cases pass; existing cases still pass.

- [ ] **Step 6: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/sessions.ts tests/server/sessions.test.ts
git commit -m "feat(server): GET /sessions/:id/messages returns the message backlog

M4 Task 3 — TUI client fetches this once on Init() to hydrate prior
transcript before subscribing to SSE. Hydrate-then-subscribe keeps the
SSE stream lean for live events and lets the HTTP fetch be retried
independently. Returns { messages: [{role, content}, ...] } in time
order; 400 on invalid uuid, 404 when row missing."
```

---

## Task 4 — Persist user / assistant / tool_result messages during a turn

**Files:**
- Modify: `src/server/routes/turns.ts`
- Test: `tests/server/turns.test.ts`

Currently `runTurnInBackground` consumes messages from `query()` and emits SSE events but never writes anything to `sessionDb`. Resume from disk would surface zero messages because nothing's persisted. Add `sessionDb.saveMessage` calls:
1. Before `query()` starts — persist the inbound user message.
2. On `assistant_message` StreamEvent — persist the assistant message.
3. On user-role Message with `tool_result` content — persist that user message (it carries the tool results the next assistant turn needs).

- [ ] **Step 1: Write the failing test**

Append to `tests/server/turns.test.ts`:

```typescript
describe('turns route — Task 4 — message persistence', () => {
  test('POST /turns persists user, assistant, and tool_result messages', async () => {
    const home = join(tmpdir(), `m4-task4-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      const app = buildApp({ runtime });
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      // MockProvider in toolUseMode emits: preamble assistant_message ->
      // tool_use(Bash echo hello-from-mock) -> tool_result user message
      // -> final assistant_message -> message_stop -> Terminal.
      MockProvider.toolUseMode = true;
      try {
        const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'run a tool please' }),
        });
        expect(turnRes.status).toBe(202);

        // Drain the SSE stream to ensure the turn completed before
        // asserting persistence. Use the same drain helper as the
        // existing tests in this file.
        await drainEvents(app, sessionId);

        const stored = runtime.sessionDb.loadMessages(sessionId);
        // Expect: 1 user (inbound) + 1 assistant (preamble + tool_use) +
        // 1 user (tool_result) + 1 assistant (final) = 4 messages.
        expect(stored.length).toBeGreaterThanOrEqual(3);
        expect(stored[0]?.role).toBe('user');
        const userText = stored[0]?.content.find((b) => b.type === 'text');
        expect(userText && 'text' in userText ? userText.text : '').toBe(
          'run a tool please',
        );
        // At least one assistant message persisted.
        expect(stored.some((m) => m.role === 'assistant')).toBe(true);
        // At least one tool_result block persisted (on a user-role message).
        expect(
          stored.some(
            (m) =>
              m.role === 'user' &&
              m.content.some((b) => b.type === 'tool_result'),
          ),
        ).toBe(true);
      } finally {
        MockProvider.toolUseMode = false;
      }
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

Confirm the file already imports `MockProvider` (per Explore agent's notes on `tests/server/turns.test.ts` — it exists for the M3 tool-use truncation regression). If `drainEvents` isn't a helper in the file, use the same SSE-drain pattern as the existing tool-use regression test in the same file (read the file's existing tests first; the pattern is repeated 2-3 times).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/turns.test.ts`
Expected: failure on `stored.length` — currently zero messages persist.

- [ ] **Step 3: Implement**

Edit `src/server/routes/turns.ts`:

```typescript
// Inside the POST /sessions/:id/turns handler, after constructing
// userMessage, BEFORE the `try` that runs the background turn —
// persist the inbound user message synchronously. saveMessage is
// cheap (bun:sqlite is in-process); the 202 response still returns
// promptly.
runtime.sessionDb.saveMessage(sessionId, {
  role: userMessage.role,
  content: userMessage.content,
});
```

Wait — `userMessage` is constructed inside `runTurnInBackground`, not the POST handler. Move the user-message save to the top of `runTurnInBackground` (still cheap; the 202 already returned before `runTurnInBackground` runs). Adjusted snippet:

```typescript
// In runTurnInBackground, replace the existing userMessage construction
// (lines 72-75) with construction + persist:
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text }],
  };
  runtime.sessionDb.saveMessage(sessionId, {
    role: userMessage.role,
    content: userMessage.content,
  });
```

Then in `handleAssistantMessage` (line 179), persist the assistant message before the for-loop that emits tool_use events:

```typescript
function handleAssistantMessage(
  msg: AssistantMessage,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  toolPool: readonly Tool<unknown, unknown>[],
  sessionDb: SessionDb,  // NEW PARAM
): void {
  sessionDb.saveMessage(sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    // ... existing body unchanged
  }
}
```

And in `handleUserMessage` (line 218):

```typescript
function handleUserMessage(
  msg: Message,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  sessionDb: SessionDb,  // NEW PARAM
): void {
  if (msg.role !== 'user') return;
  // Persist tool_result-bearing user messages so resume can replay them.
  // Non-tool-result user messages (e.g. loop-detector guidance) are
  // also persisted — the next assistant turn references them and resume
  // must reconstruct exact prior context.
  sessionDb.saveMessage(sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    // ... existing body unchanged
  }
}
```

Add `import type { SessionDb } from '../../agent/sessionDb.js';` to the top of `turns.ts`.

Update the two call sites in `runTurnInBackground` (lines 142, 152-159) to pass `runtime.sessionDb`:

```typescript
        handleUserMessage(event, bus, sessionId, currentBlock, pendingToolUses, runtime.sessionDb);
```

```typescript
        handleAssistantMessage(
          streamEvent.message,
          bus,
          sessionId,
          currentBlock,
          pendingToolUses,
          runtime.toolPool,
          runtime.sessionDb,
        );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/server/turns.test.ts`
Expected: new test passes; existing M3 truncation-regression test still passes.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/turns.ts tests/server/turns.test.ts
git commit -m "feat(server): persist user/assistant/tool_result messages in turns route

M4 Task 4 — sessionDb.saveMessage now fires for the inbound user message
at turn start, for every assistant message via assistant_message events,
and for every tool_result-bearing user message coming back from query().
Resume from disk will surface the full prior transcript via Task 3's
GET /sessions/:id/messages."
```

---

## Task 5 — `maxTokens` + `preflight` on `RuntimeOptions`; thread `maxTokens` through `turns.ts`

**Files:**
- Modify: `src/server/runtime.ts` (RuntimeOptions + Runtime types)
- Modify: `src/server/routes/turns.ts` (consume runtime.maxTokens, drop DEFAULT_MAX_TOKENS)
- Test: `tests/server/runtime.test.ts`, `tests/server/turns.test.ts`

Add `maxTokens?: number` and `preflight?: boolean` to RuntimeOptions. Echo `maxTokens` (resolved to either user-supplied or a default constant) on the Runtime. Turns route consumes `runtime.maxTokens` instead of the local `DEFAULT_MAX_TOKENS = 4096`. The `preflight` field is added in this task but not yet *used* — Task 6 wires the execution.

The default for `maxTokens` matches `src/main.ts`'s `DEFAULT_MAX_TOKENS` constant (per `--max-tokens <n>` flag default of 12000). To stay aligned without re-importing, define the default inside `runtime.ts` as a local constant; if the user passes the CLI default via `--max-tokens 12000` it lands explicitly.

- [ ] **Step 1: Verify the source-of-truth default**

Run: `rg "DEFAULT_MAX_TOKENS" src/main.ts`
Expected: a single hit with the numeric default. Read the surrounding line to confirm `12000`. Record the number for the runtime.ts constant.

- [ ] **Step 2: Write the failing tests**

Append to `tests/server/runtime.test.ts`:

```typescript
describe('buildRuntime — Task 5 — maxTokens + preflight options', () => {
  test('echoes opts.maxTokens on runtime', async () => {
    const home = join(tmpdir(), `m4-task5a-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      maxTokens: 8000,
    });
    try {
      expect(runtime.maxTokens).toBe(8000);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to 12000 when maxTokens omitted', async () => {
    const home = join(tmpdir(), `m4-task5b-${Date.now()}`);
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      expect(runtime.maxTokens).toBe(12000);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/server/runtime.test.ts`
Expected: typecheck failure (`maxTokens` not on `RuntimeOptions` / `Runtime`).

- [ ] **Step 4: Implement runtime.ts changes**

Edit `src/server/runtime.ts`:

```typescript
// Top of file, near the existing imports:
const DEFAULT_MAX_TOKENS = 12000; // Matches src/main.ts CLI default.
```

```typescript
// In RuntimeOptions, after resumeId:
  /** Max tokens per provider call. Defaults to 12000 to match the
   *  src/main.ts CLI default; users override via --max-tokens. */
  maxTokens?: number;
  /** Run provider preflight at boot. Defaults to true; --no-preflight
   *  sets this false (subject to Task 6 wiring). */
  preflight?: boolean;
```

```typescript
// In Runtime type, after resumeId:
  maxTokens: number;
```

```typescript
// In the return object, alongside resumeId:
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
```

- [ ] **Step 5: Implement turns.ts changes**

Edit `src/server/routes/turns.ts`:

Remove the local constant:

```typescript
// DELETE this line near the top:
const DEFAULT_MAX_TOKENS = 4096;
```

Replace `maxTokens: DEFAULT_MAX_TOKENS,` (line 96 inside the `query` call) with:

```typescript
      maxTokens: runtime.maxTokens,
```

- [ ] **Step 6: Add the turns-route test**

Append to `tests/server/turns.test.ts`:

```typescript
test('turns route honors runtime.maxTokens', async () => {
  const home = join(tmpdir(), `m4-task5c-${Date.now()}`);
  const runtime = await buildRuntime({
    cwd: process.cwd(),
    provider: 'mock',
    harnessHome: home,
    maxTokens: 1234,
  });
  try {
    expect(runtime.maxTokens).toBe(1234);
    // Surface check: MockProvider records its last maxTokens. After a
    // turn runs, the recorded value should equal runtime.maxTokens.
    const app = buildApp({ runtime });
    const created = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(turnRes.status).toBe(202);
    await drainEvents(app, sessionId);
    expect(MockProvider.lastMaxTokens).toBe(1234);
  } finally {
    await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
```

This test depends on `MockProvider.lastMaxTokens` existing. If it doesn't already exist on MockProvider (per the Explore agent's notes, MockProvider has `toolUseMode` but no maxTokens recording yet), add a static field to MockProvider:

Edit `src/providers/mock.ts` (or wherever MockProvider lives — find via `rg "class MockProvider" src/providers/`). Add a static `lastMaxTokens: number | undefined` and set it inside the `stream()` method:

```typescript
export class MockProvider implements LLMProvider {
  static toolUseMode = false;
  static lastMaxTokens: number | undefined = undefined;
  // ... existing fields

  stream(req: ProviderStreamRequest): AsyncIterable<...> {
    MockProvider.lastMaxTokens = req.maxTokens;
    // ... existing body
  }
}
```

Reset it in test setup:

```typescript
beforeEach(() => {
  MockProvider.lastMaxTokens = undefined;
});
```

(Add the import for `beforeEach` from `bun:test` if not already imported.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/server/runtime.test.ts tests/server/turns.test.ts`
Expected: new cases pass; all prior pass.

- [ ] **Step 8: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 9: Commit**

```bash
git add src/server/runtime.ts src/server/routes/turns.ts src/providers/mock.ts tests/server/runtime.test.ts tests/server/turns.test.ts
git commit -m "feat(server): runtime.maxTokens + preflight RuntimeOptions

M4 Task 5 — RuntimeOptions gains maxTokens (default 12000, matches CLI)
and preflight (boolean, used in Task 6). Turns route consumes
runtime.maxTokens instead of the local 4096 const, so --max-tokens flag
flows end-to-end. MockProvider records lastMaxTokens for assertion in
tests/server/turns.test.ts."
```

---

## Task 6 — Run preflight in `buildRuntime`

**Files:**
- Modify: `src/server/runtime.ts`
- Modify: `src/server/errors.ts` (add `PreflightError`)
- Test: `tests/server/runtime.test.ts`

Execute `preflightProvider` (and `preflightToolCalling` for Ollama only) inside `buildRuntime`, after the provider resolves and before the function returns. Honor `opts.preflight === false` to skip. On failure, throw `PreflightError` carrying the preflight kind/message so `tuiLauncher` can show a clean user-facing error.

Use a custom mock that fails on the second `stream()` call to exercise the failure path deterministically.

- [ ] **Step 1: Add `PreflightError` to `src/server/errors.ts`**

Edit `src/server/errors.ts`:

```typescript
import type { ProviderPreflightKind } from '../providers/preflight.js';

export class PreflightError extends Error {
  readonly kind: ProviderPreflightKind;
  constructor(kind: ProviderPreflightKind, message: string) {
    super(message);
    this.name = 'PreflightError';
    this.kind = kind;
  }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/server/runtime.test.ts`:

```typescript
describe('buildRuntime — Task 6 — preflight execution', () => {
  test('runs preflight against the resolved provider by default', async () => {
    const home = join(tmpdir(), `m4-task6a-${Date.now()}`);
    MockProvider.preflightCalls = 0;
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    try {
      // MockProvider records every stream() call; preflight makes exactly
      // one (preflightProvider drains a "OK" stream).
      expect(MockProvider.preflightCalls).toBe(1);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('skips preflight when opts.preflight === false', async () => {
    const home = join(tmpdir(), `m4-task6b-${Date.now()}`);
    MockProvider.preflightCalls = 0;
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      preflight: false,
    });
    try {
      expect(MockProvider.preflightCalls).toBe(0);
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('throws PreflightError when preflight fails', async () => {
    const home = join(tmpdir(), `m4-task6c-${Date.now()}`);
    MockProvider.preflightShouldFail = true;
    try {
      await expect(
        buildRuntime({
          cwd: process.cwd(),
          provider: 'mock',
          harnessHome: home,
        }),
      ).rejects.toThrow(/preflight/i);
    } finally {
      MockProvider.preflightShouldFail = false;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/server/runtime.test.ts`
Expected: tests fail because preflight not yet wired; `MockProvider.preflightCalls`/`preflightShouldFail` static fields don't exist.

- [ ] **Step 4: Extend MockProvider**

Edit `src/providers/mock.ts`. Add to the class:

```typescript
static preflightCalls = 0;
static preflightShouldFail = false;
```

In the `stream()` method, increment the counter at the top and short-circuit on failure mode:

```typescript
stream(req: ProviderStreamRequest): AsyncIterable<...> {
  MockProvider.lastMaxTokens = req.maxTokens;
  MockProvider.preflightCalls += 1;
  if (MockProvider.preflightShouldFail) {
    // Emit a stream that errors on consumption, classifiable as
    // 'unknown' by classifyProviderPreflightError.
    return (async function* () {
      throw new Error('mock preflight failure');
    })();
  }
  // ... existing body
}
```

Update test `beforeEach` to reset all three statics:

```typescript
beforeEach(() => {
  MockProvider.lastMaxTokens = undefined;
  MockProvider.preflightCalls = 0;
  MockProvider.preflightShouldFail = false;
  MockProvider.toolUseMode = false;
});
```

- [ ] **Step 5: Implement preflight in `buildRuntime`**

Edit `src/server/runtime.ts`. After the provider resolves (line 119-122 area) and before the sessionDb open block (currently Task 1's site):

```typescript
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { PreflightError } from './errors.js';
```

```typescript
// After: `const provider = resolved.transport;`
// Before: the sessionDb-open block.
if (opts.preflight !== false) {
  const result = await preflightProvider({
    provider,
    providerName: resolved.transport.name,
    model: resolved.model,
  });
  if (!result.ok) {
    throw new PreflightError(result.kind, result.message);
  }
  // Ollama needs the tool-calling smoke check too — see
  // terminalRepl.ts:486-504. Other providers are tool-call-capable by
  // schema; only Ollama can return a model that silently ignores tools.
  if (resolved.transport.name === 'ollama' && toolPool.length > 0) {
    const toolResult = await preflightToolCalling({
      provider,
      providerName: resolved.transport.name,
      model: resolved.model,
    });
    if (!toolResult.ok) {
      throw new PreflightError(toolResult.kind, toolResult.message);
    }
  }
}
```

`toolPool` must be in scope here. Move the `provider`-resolution block to AFTER `assembleToolPool` if it isn't already (per the current `runtime.ts:109-122`, `assembleToolPool` already runs first and `resolveProvider` follows). Good — `toolPool` is in scope.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/server/runtime.test.ts`
Expected: all 3 new cases pass; existing 9 still pass.

- [ ] **Step 7: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 8: Commit**

```bash
git add src/server/runtime.ts src/server/errors.ts src/providers/mock.ts tests/server/runtime.test.ts
git commit -m "feat(server): buildRuntime runs provider preflight unless disabled

M4 Task 6 — preflightProvider fires after provider resolution; for ollama
it's followed by preflightToolCalling when toolPool is non-empty. Failure
throws PreflightError carrying the kind/message so tuiLauncher can show
a clean user-facing error. --no-preflight skips both. Mirrors the
terminalRepl preflight chain at lines 447-504."
```

---

## Task 7 — `tuiLauncher` forwards all M4-supported flags

**Files:**
- Modify: `src/cli/tuiLauncher.ts`
- Test: `tests/cli/tuiLauncher.test.ts`

Extend `TuiLaunchOptions` typing, and update the `buildRuntime(...)` call inside `runTuiLauncher` to pass every M4-supported flag: `bundle`, `provider`, `model`, `permissionMode`, `maxTokens`, `db`, `resume`, `cache` (inverted to `cacheEnabled`), `preflight`. Catch `PreflightError` and `SessionNotFoundError` to print user-friendly stderr text + return non-zero before spawning anything.

- [ ] **Step 1: Write the failing tests**

Edit `tests/cli/tuiLauncher.test.ts`. The existing tests cover binary discovery only. Add a new describe block that mocks the runtime/server modules and asserts the buildRuntime call arguments. Use a small ad-hoc mock approach because `runTuiLauncher` does dynamic imports:

```typescript
import { mock } from 'bun:test';
import { runTuiLauncher } from '../../src/cli/tuiLauncher.js';

describe('runTuiLauncher — Task 7 — flag forwarding', () => {
  let recordedBuildOpts: Record<string, unknown> | null = null;
  const fakeRuntime = {
    dispose: async () => {},
  };
  const fakeServer = { port: 12345, stop: async () => {} };

  beforeEach(() => {
    recordedBuildOpts = null;
    // Force a known sov-tui binary so findTuiBinary returns non-null.
    process.env.SOV_TUI_BIN = '/bin/true';
    // Mock fetch so POST /sessions returns a fake session id without
    // touching a real server (we never start one in this test).
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ sessionId: 'test-session-id' }), {
        status: 201,
      }),
    ) as unknown as typeof fetch;
    // child_process.spawn: replace with a stub that "exits 0" instantly.
    mock.module('node:child_process', () => ({
      spawn: () => {
        const child = new (require('node:events').EventEmitter)();
        setImmediate(() => child.emit('exit', 0));
        return child;
      },
    }));
    mock.module('../../src/server/runtime.js', () => ({
      buildRuntime: async (opts: Record<string, unknown>) => {
        recordedBuildOpts = opts;
        return fakeRuntime;
      },
    }));
    mock.module('../../src/server/index.js', () => ({
      startServer: async () => fakeServer,
    }));
  });

  afterEach(() => {
    delete process.env.SOV_TUI_BIN;
    mock.restore();
  });

  test('forwards bundle, provider, model, permissionMode, maxTokens, db, cache, preflight', async () => {
    await runTuiLauncher({
      bundle: '/path/to/bundle',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypass',
      maxTokens: 7777,
      db: '/tmp/m4.db',
      cache: false,           // CLI --no-cache → opts.cache === false
      preflight: false,       // CLI --no-preflight → opts.preflight === false
    });
    expect(recordedBuildOpts).toMatchObject({
      bundleRoot: '/path/to/bundle',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypass',
      maxTokens: 7777,
      dbPath: '/tmp/m4.db',
      cacheEnabled: false,
      preflight: false,
    });
  });

  test('forwards resume id and skips POST /sessions when resumeId is set', async () => {
    let postSessionsCalled = false;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/sessions') && !u.includes('/sessions/')) {
        postSessionsCalled = true;
      }
      return new Response(JSON.stringify({ sessionId: 'resumed-id' }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    await runTuiLauncher({ resume: 'resumed-id' });
    expect(recordedBuildOpts?.resumeId).toBe('resumed-id');
    // When resuming, the launcher should NOT create a fresh session —
    // it uses the one validated by buildRuntime.
    expect(postSessionsCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/tuiLauncher.test.ts`
Expected: failures — flags currently dropped, POST /sessions still fires unconditionally.

- [ ] **Step 3: Implement**

Edit `src/cli/tuiLauncher.ts`. Expand the option type:

```typescript
export type TuiLaunchOptions = {
  bundle?: unknown;
  provider?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  maxTokens?: unknown;
  db?: unknown;
  resume?: unknown;
  /** CLI --no-cache → opts.cache === false; otherwise omitted/true. */
  cache?: unknown;
  /** CLI --no-preflight → opts.preflight === false; otherwise omitted/true. */
  preflight?: unknown;
  [k: string]: unknown;
};
```

Helper for typed flag pickup:

```typescript
function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickPermissionMode(value: unknown): 'default' | 'ask' | 'bypass' | undefined {
  if (value === 'default' || value === 'ask' || value === 'bypass') return value;
  return undefined;
}
```

Replace the `buildRuntime({ ... })` call:

```typescript
  const buildOpts: Parameters<typeof buildRuntime>[0] = {
    cwd: process.cwd(),
  };
  const bundle = pickString(opts.bundle);
  if (bundle !== undefined) buildOpts.bundleRoot = bundle;
  const provider = pickString(opts.provider);
  if (provider !== undefined) buildOpts.provider = provider;
  const model = pickString(opts.model);
  if (model !== undefined) buildOpts.model = model;
  const permissionMode = pickPermissionMode(opts.permissionMode);
  if (permissionMode !== undefined) buildOpts.permissionMode = permissionMode;
  const maxTokens = pickNumber(opts.maxTokens);
  if (maxTokens !== undefined) buildOpts.maxTokens = maxTokens;
  const db = pickString(opts.db);
  if (db !== undefined) buildOpts.dbPath = db;
  const resume = pickString(opts.resume);
  if (resume !== undefined) buildOpts.resumeId = resume;
  // CLI semantics: --no-cache sets opts.cache === false (Commander
  // convention). Any other state → leave cacheEnabled default-on.
  if (pickBoolean(opts.cache) === false) buildOpts.cacheEnabled = false;
  if (pickBoolean(opts.preflight) === false) buildOpts.preflight = false;

  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime(buildOpts);
  } catch (err) {
    const { PreflightError, SessionNotFoundError } = await import('../server/errors.js');
    if (err instanceof PreflightError) {
      process.stderr.write(
        `sov: provider preflight failed (${err.kind}): ${err.message}\n`,
      );
      process.stderr.write(
        '     run with --no-preflight to skip this check, or fix the underlying credential/quota issue.\n',
      );
      return 1;
    }
    if (err instanceof SessionNotFoundError) {
      process.stderr.write(`sov: ${err.message}\n`);
      process.stderr.write(
        '     list sessions with `sov` --ui repl + /sessions, or omit --resume to start a fresh one.\n',
      );
      return 1;
    }
    throw err;
  }
```

Replace the POST /sessions block with conditional skip on resume:

```typescript
  let sessionId: string;
  if (runtime.resumeId !== undefined) {
    sessionId = runtime.resumeId;
  } else {
    try {
      const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: 'POST',
      });
      if (!createRes.ok) {
        throw new Error(`POST /sessions returned ${createRes.status}`);
      }
      const body = (await createRes.json()) as { sessionId: string };
      sessionId = body.sessionId;
    } catch (err) {
      console.error(
        `sov: failed to create session: ${err instanceof Error ? err.message : String(err)}`,
      );
      await server.stop();
      await runtime.dispose();
      return 1;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/tuiLauncher.test.ts`
Expected: both new cases pass; existing 3 binary-discovery cases still pass.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/cli/tuiLauncher.ts tests/cli/tuiLauncher.test.ts
git commit -m "feat(cli): tuiLauncher forwards M4 flags + handles resume/preflight errors

M4 Task 7 — bundle, provider, model, permissionMode, maxTokens, db,
resume, cache, preflight all reach buildRuntime now. PreflightError and
SessionNotFoundError surface as user-friendly stderr messages before any
server starts. When --resume is set, skip POST /sessions and use the
validated id from buildRuntime."
```

---

## Task 8 — Warnings for deferred-subsystem flags; legacy-input hard error

**Files:**
- Modify: `src/cli/tuiLauncher.ts`
- Test: `tests/cli/tuiLauncher.test.ts`

Flags whose downstream subsystem lands later (`transcript` → M7, `captureFixture`/`replayFixture` → M8, `agent`/`stateDir` → M7, `verbose` → M9) get a one-line stderr warning naming the target milestone. `legacyInput` is REPL-only by definition (readline fallback for terminalRepl) — hard error and exit non-zero.

This avoids silent semantic divergence: per Postmortem Rule 3, audit before declaring parity. If a user passes `--transcript foo.jsonl --ui tui` today, the file would not be written but the user wouldn't know. Explicit warnings keep the gap visible.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli/tuiLauncher.test.ts`:

```typescript
describe('runTuiLauncher — Task 8 — deferred flag warnings + legacy-input error', () => {
  let stderrBuf: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrBuf = '';
    origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stderr.write;
    // Same fixture setup as Task 7 (binary, runtime, server, fetch, spawn
    // mocks). Refactor the Task 7 setup into a helper and call it here.
  });

  afterEach(() => {
    process.stderr.write = origWrite;
  });

  test('warns on --transcript with target milestone', async () => {
    await runTuiLauncher({ transcript: '/tmp/t.jsonl' });
    expect(stderrBuf).toContain('--transcript');
    expect(stderrBuf).toMatch(/M7/);
  });

  test('warns on --capture-fixture', async () => {
    await runTuiLauncher({ captureFixture: '/tmp/c.json' });
    expect(stderrBuf).toContain('--capture-fixture');
    expect(stderrBuf).toMatch(/M8/);
  });

  test('warns on --replay-fixture', async () => {
    await runTuiLauncher({ replayFixture: '/tmp/r.json' });
    expect(stderrBuf).toContain('--replay-fixture');
    expect(stderrBuf).toMatch(/M8/);
  });

  test('warns on --agent', async () => {
    await runTuiLauncher({ agent: 'scheduled-mission' });
    expect(stderrBuf).toContain('--agent');
    expect(stderrBuf).toMatch(/M7/);
  });

  test('warns on --state-dir', async () => {
    await runTuiLauncher({ stateDir: '/tmp/state' });
    expect(stderrBuf).toContain('--state-dir');
    expect(stderrBuf).toMatch(/M7/);
  });

  test('warns on --verbose', async () => {
    await runTuiLauncher({ verbose: true });
    expect(stderrBuf).toContain('--verbose');
    expect(stderrBuf).toMatch(/M9/);
  });

  test('hard-errors on --legacy-input', async () => {
    const code = await runTuiLauncher({ legacyInput: true });
    expect(code).not.toBe(0);
    expect(stderrBuf).toContain('--legacy-input');
    expect(stderrBuf).toContain('--ui repl');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/tuiLauncher.test.ts`
Expected: 7 new failures.

- [ ] **Step 3: Implement**

Edit `src/cli/tuiLauncher.ts`. Add an early check after the binary lookup:

```typescript
// After: `if (binary === null) { ... return 70; }`
// Before: the buildRuntime call.

// --legacy-input is REPL-only by definition (readline fallback for
// terminalRepl). Refuse to launch with --ui tui rather than silently
// drop the flag — keeps the semantic gap visible.
if (opts.legacyInput === true) {
  process.stderr.write(
    'sov: --legacy-input is incompatible with --ui tui (readline fallback is REPL-only).\n',
  );
  process.stderr.write(
    '     use --ui repl --legacy-input, or drop --legacy-input.\n',
  );
  return 2;
}

// Flags whose subsystem lands in a later milestone — warn so users
// aren't silently surprised by missing behavior. Per Postmortem Rule 3:
// audit before declaring parity; the gap is explicit here.
const deferredFlagWarnings: Array<{ flag: string; opt: keyof TuiLaunchOptions; milestone: string }> = [
  { flag: '--transcript', opt: 'transcript', milestone: 'M7' },
  { flag: '--capture-fixture', opt: 'captureFixture', milestone: 'M8' },
  { flag: '--replay-fixture', opt: 'replayFixture', milestone: 'M8' },
  { flag: '--agent', opt: 'agent', milestone: 'M7' },
  { flag: '--state-dir', opt: 'stateDir', milestone: 'M7' },
  { flag: '--verbose', opt: 'verbose', milestone: 'M9' },
];
for (const { flag, opt, milestone } of deferredFlagWarnings) {
  const value = opts[opt];
  if (value !== undefined && value !== false) {
    process.stderr.write(
      `sov: ${flag} is not yet supported with --ui tui (targeting milestone ${milestone}); continuing without it.\n`,
    );
  }
}
```

Extend `TuiLaunchOptions` with these flags (typed `unknown`):

```typescript
export type TuiLaunchOptions = {
  bundle?: unknown;
  provider?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  maxTokens?: unknown;
  db?: unknown;
  resume?: unknown;
  cache?: unknown;
  preflight?: unknown;
  // Deferred subsystems — accepted-and-warned.
  transcript?: unknown;
  captureFixture?: unknown;
  replayFixture?: unknown;
  agent?: unknown;
  stateDir?: unknown;
  verbose?: unknown;
  // REPL-only — hard error.
  legacyInput?: unknown;
  [k: string]: unknown;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/tuiLauncher.test.ts`
Expected: all 7 new cases pass; all prior cases still pass.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/cli/tuiLauncher.ts tests/cli/tuiLauncher.test.ts
git commit -m "feat(cli): warn-and-continue on deferred-subsystem flags; legacy-input hard-error

M4 Task 8 — --transcript / --capture-fixture / --replay-fixture / --agent /
--state-dir / --verbose all surface a one-line stderr warning naming
the target milestone instead of being silently dropped. --legacy-input
with --ui tui hard-errors (readline fallback is REPL-only by definition).
Per Postmortem Rule 3: audit before parity, keep gaps visible."
```

---

## Task 9 — TUI Go client hydrates transcript on `Init()`

**Files:**
- Create: `packages/tui/internal/transport/http.go`
- Create: `packages/tui/internal/transport/http_test.go`
- Modify: `packages/tui/internal/app/app.go`
- Test: `packages/tui/internal/app/app_test.go`

On `Init()`, the Go TUI fires off a `tea.Cmd` that fetches `GET /sessions/:id/messages`, decodes the body, and yields a `messagesFetchedMsg` carrying the message list. `Update` handles it by appending each message to the transcript before the live SSE stream attaches. Resume case: prior turns visible immediately; fresh case: zero messages, no-op.

- [ ] **Step 1: Write the failing Go transport test**

Create `packages/tui/internal/transport/http_test.go`:

```go
package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchMessages_DecodesBacklog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/abc/messages" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages": []map[string]any{
				{
					"role": "user",
					"content": []map[string]any{
						{"type": "text", "text": "hello"},
					},
				},
				{
					"role": "assistant",
					"content": []map[string]any{
						{"type": "text", "text": "hi back"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	msgs, err := FetchMessages(context.Background(), srv.URL, "abc")
	if err != nil {
		t.Fatalf("FetchMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("len(msgs) = %d, want 2", len(msgs))
	}
	if msgs[0].Role != "user" || len(msgs[0].Content) != 1 || msgs[0].Content[0].Text != "hello" {
		t.Fatalf("messages[0] mismatch: %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content[0].Text != "hi back" {
		t.Fatalf("messages[1] mismatch: %+v", msgs[1])
	}
}

func TestFetchMessages_HandlesNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := FetchMessages(context.Background(), srv.URL, "missing")
	if err == nil {
		t.Fatal("expected error on 404, got nil")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/tui && go test ./internal/transport/...`
Expected: compile error — `FetchMessages` not defined.

- [ ] **Step 3: Implement `FetchMessages`**

Create `packages/tui/internal/transport/http.go`:

```go
// Package transport — HTTP client helpers complementing the SSE consumer.
//
// FetchMessages hydrates the session's prior message backlog on Init().
// The Go TUI calls this once before subscribing to the SSE stream so
// resume flows render immediately. Fresh sessions return an empty array.

package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// StoredContentBlock is the wire shape of a single content block in
// stored messages. Mirrors the TS shape: { type: string, text?: string,
// tool_use_id?: string, content?: ... }. Only `text` is decoded fully;
// other types are passed through as raw JSON in Raw for future renderers.
type StoredContentBlock struct {
	Type string          `json:"type"`
	Text string          `json:"text,omitempty"`
	Raw  json.RawMessage `json:"-"`
}

// StoredMessage is a single persisted message: role + content blocks.
type StoredMessage struct {
	Role    string               `json:"role"`
	Content []StoredContentBlock `json:"content"`
}

type messagesResponse struct {
	Messages []StoredMessage `json:"messages"`
}

// FetchMessages issues GET <baseURL>/sessions/<sessionID>/messages and
// returns the decoded backlog. Returns an error on non-2xx response or
// transport failure; an empty backlog is `(nil, nil)` (200 with []).
func FetchMessages(ctx context.Context, baseURL, sessionID string) ([]StoredMessage, error) {
	url := fmt.Sprintf("%s/sessions/%s/messages", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("get messages: status %d: %s", res.StatusCode, string(body))
	}
	var payload messagesResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode messages: %w", err)
	}
	return payload.Messages, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/tui && go test ./internal/transport/...`
Expected: both new cases pass.

- [ ] **Step 5: Write the failing App test**

Add to `packages/tui/internal/app/app_test.go` (use the existing teatest pattern from `TestApp_consumesMultipleEventsFromSingleConnection`):

```go
func TestApp_hydratesTranscriptFromPriorMessages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sessions/test-session/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"messages": []map[string]any{
					{"role": "user", "content": []map[string]any{{"type": "text", "text": "old user msg"}}},
					{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "old asst msg"}}},
				},
			})
		case "/sessions/test-session/events":
			// SSE stream that closes immediately on turn_complete.
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: turn_complete\ndata: {\"type\":\"turn_complete\",\"seq\":0,\"sessionId\":\"test-session\",\"finishReason\":\"end_turn\"}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	m := New(srv.URL, "test-session")
	tm := teatest.NewTestModel(t, m, teatest.WithInitialTermSize(80, 24))
	teatest.WaitFor(t, tm.Output(), func(bts []byte) bool {
		return bytes.Contains(bts, []byte("old user msg")) &&
			bytes.Contains(bts, []byte("old asst msg"))
	}, teatest.WithDuration(3*time.Second))
	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd packages/tui && go test ./internal/app/...`
Expected: failure — `New()` doesn't fetch messages on Init.

- [ ] **Step 7: Implement App.Init hydration**

Edit `packages/tui/internal/app/app.go`. Add a message + cmd:

```go
type messagesFetchedMsg struct {
	messages []transport.StoredMessage
	err      error
}

func (m Model) fetchMessagesCmd() tea.Cmd {
	return func() tea.Msg {
		msgs, err := transport.FetchMessages(m.ctx, m.baseURL, m.sessionID)
		return messagesFetchedMsg{messages: msgs, err: err}
	}
}
```

Update `Init()`:

```go
func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.fetchMessagesCmd(),
		// existing SSE consumer launch goes here, unchanged
		m.consumeSSECmd(),
	)
}
```

Add handler in `Update`:

```go
case messagesFetchedMsg:
	if msg.err != nil {
		m.transcript.AppendSystemLine(fmt.Sprintf("could not load prior messages: %v", msg.err))
		return m, nil
	}
	for _, sm := range msg.messages {
		for _, block := range sm.Content {
			if block.Type == "text" && block.Text != "" {
				if sm.Role == "user" {
					m.transcript.AppendUserMessage(block.Text)
				} else if sm.Role == "assistant" {
					m.transcript.AppendAssistantText(block.Text)
				}
				// tool_use / tool_result blocks: M4 minimal hydration is
				// text-only. Richer rendering of historical tool_use cards
				// lands when M7 wires trajectory capture.
			}
		}
	}
	return m, nil
```

This requires `m.baseURL` on the model. If it's not already there (the model currently stores `streamURL`), add `baseURL string` as well. `New()` factors out the base by stripping `/sessions/:id/events` from the existing streamURL — or take a new constructor signature `New(baseURL, sessionID string)` and build the streamURL inside. Choose whichever fits the existing constructor without breaking `cmd/sov-tui/main.go`. Also expose appropriate `Transcript.AppendUserMessage` / `Transcript.AppendAssistantText` / `Transcript.AppendSystemLine` helpers if any don't exist; the existing M3 transcript already renders text deltas, so the underlying append path exists — wrap it in a clean helper signature for these three call shapes.

Update `packages/tui/cmd/sov-tui/main.go`: pass the base URL into `New`:

```go
baseURL := fmt.Sprintf("http://127.0.0.1:%d", *port)
m := app.New(baseURL, *sessionID)
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/tui && go test ./...`
Expected: new test passes; existing app/transport tests still pass (the 3 t.Skip'd tests from M3 remain skipped).

- [ ] **Step 9: Commit**

```bash
git add packages/tui/internal/transport/http.go packages/tui/internal/transport/http_test.go packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go packages/tui/cmd/sov-tui/main.go
git commit -m "feat(tui): hydrate transcript from GET /sessions/:id/messages on Init

M4 Task 9 — Bubble Tea App.Init fires a fetchMessagesCmd alongside the
SSE consumer. messagesFetchedMsg handler appends each prior text block
to the transcript with user/assistant role styling. Resume flows now
render the full prior conversation immediately. Tool_use/tool_result
historical rendering deferred to M7 trajectory capture wiring."
```

---

## Task 10 — Integration smoke for `runTuiLauncher`

**Files:**
- Modify: `tests/cli/tuiLauncher.test.ts`

The Task 7 + 8 tests prove flag forwarding and warnings in isolation. This task pins one full-path integration: `runTuiLauncher` boots `buildRuntime` (real, mock provider) + `startServer` (real, in-process Hono on random port) + mocked `spawn`, asserts the spawned child gets the correct `--port` + `--session-id` args, and asserts the server can be reached at that port for a real `GET /sessions/:id/messages` round-trip. Removes the TODO comment at `src/cli/tuiLauncher.ts:76-80`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/tuiLauncher.test.ts`:

```typescript
describe('runTuiLauncher — Task 10 — end-to-end with mocked spawn', () => {
  test('builds real runtime + server, spawns child with --port and --session-id, server reachable', async () => {
    let spawnedArgs: string[] | null = null;
    let serverPort: number | null = null;
    process.env.SOV_TUI_BIN = '/bin/true';

    mock.module('node:child_process', () => ({
      spawn: (_bin: string, args: string[]) => {
        spawnedArgs = args;
        // Capture port from args before "exiting" so we can hit the
        // server while runTuiLauncher is parked on the child.exit promise.
        const portIdx = args.indexOf('--port');
        if (portIdx !== -1) serverPort = Number(args[portIdx + 1]);
        const child = new (require('node:events').EventEmitter)();
        // Defer the exit so we have time to fetch from the live server.
        setTimeout(() => child.emit('exit', 0), 100);
        return child;
      },
    }));

    // Fire runTuiLauncher in the background; concurrently fetch the
    // server's /messages route to prove it's bound + responding.
    const launchPromise = runTuiLauncher({ provider: 'mock' });

    // Wait a tick for the server to bind. The spawnedArgs callback above
    // captures the port; poll for it.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (serverPort !== null) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });

    const sessionIdIdx = spawnedArgs!.indexOf('--session-id');
    const sessionId = spawnedArgs![sessionIdIdx + 1];
    const res = await fetch(
      `http://127.0.0.1:${serverPort}/sessions/${sessionId}/messages`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);

    const code = await launchPromise;
    expect(code).toBe(0);
    expect(spawnedArgs).toContain('--port');
    expect(spawnedArgs).toContain('--session-id');
  });
});
```

The test uses `provider: 'mock'` so preflight (Task 6) passes cheaply against the mock.

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/cli/tuiLauncher.test.ts`
Expected: this new case passes (the implementation already works from Tasks 1-8; this test only verifies end-to-end integration).

If it fails, debug the integration — likely a race between server bind and the fetch call. The polling loop above should handle it.

- [ ] **Step 3: Remove the now-resolved TODO**

Edit `src/cli/tuiLauncher.ts`. Delete the comment block at lines 76-80:

```typescript
// DELETE these lines:
// TODO M4+: integration test that mocks child_process.spawn + startServer
// and exercises this function end-to-end (build runtime → start server →
// POST /sessions → spawn child → settle on child exit). Currently only
// findTuiBinary[From]() has coverage; the orchestration here is verified by
// the manual smoke alone.
```

- [ ] **Step 4: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add src/cli/tuiLauncher.ts tests/cli/tuiLauncher.test.ts
git commit -m "test(cli): tuiLauncher end-to-end smoke with real buildRuntime + server

M4 Task 10 — pins the orchestration the M3 TODO punted on: real runtime,
real Hono server on a random port, mocked spawn captures --port and
--session-id, and an in-flight HTTP fetch proves the server is reachable
while the launcher waits for the child to exit. Removes the
'integration test deferred' TODO comment."
```

---

## Task 11 — Docs, prereq flip, state snapshot, sov upgrade, manual smoke

**Files:**
- Modify: `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`
- Modify: `docs/03-cli-reference/usage.md`
- Modify: `docs/06-testing/testing-log.md`
- Create: `docs/07-history/state/2026-05-14.md`
- Archive: `docs/07-history/state/2026-05-13.md` → `docs/07-history/state/archive/2026-05-13.md`
- Modify: `CLAUDE.md`, `AGENTS.md`
- Modify: `DECISIONS.md`

- [ ] **Step 1: Flip the three M4 checkboxes**

Edit `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`. Find rows 6 (Session DB persistence), 9 (Preflight checks), 23 (Full CLI flag forwarding) and change their checkboxes from `[ ]` to `[x]` with the close-out shape used by prior milestones (commit SHA + date next to the box if the doc's existing pattern uses that — match whatever's there).

- [ ] **Step 2: Add the `--ui tui` flag-coverage table to `docs/03-cli-reference/usage.md`**

Find the appropriate section under "Profiles" or "Operation" (read the file first to choose) and add:

```markdown
### `--ui tui` flag coverage (Phase 16.1 M4)

`--ui tui` is opt-in; `--ui repl` (default) routes to the legacy terminalRepl. The TUI accepts the following `sov` flags:

| Flag | Status | Notes |
|---|---|---|
| `--bundle <path>` | Wired (M3) | |
| `--provider <name>` | Wired (M3) | |
| `-m, --model <name>` | Wired (M3) | |
| `--permission-mode <mode>` | Wired (M4) | |
| `--max-tokens <n>` | Wired (M4) | Default 12000 |
| `--db <path>` | Wired (M4) | Default `<harnessHome>/sessions.db` |
| `--resume <id>` | Wired (M4) | Hydrates prior transcript via `GET /sessions/:id/messages` |
| `--no-cache` | Wired (M4) | |
| `--no-preflight` | Wired (M4) | Skips provider preflight |
| `--transcript <path>` | **Warn** | Wires in M7 (trajectory capture) |
| `--capture-fixture <path>` | **Warn** | Wires in M8 (capture/replay) |
| `--replay-fixture <path>` | **Warn** | Wires in M8 |
| `--agent <name>` | **Warn** | Wires in M7 (sub-agent scheduler + scheduled-mission) |
| `--state-dir <path>` | **Warn** | Wires in M7 |
| `-v, --verbose` | **Warn** | Wires in M9 (visual polish) |
| `--legacy-input` | **Error** | REPL-only; readline fallback for `--ui repl` |
```

- [ ] **Step 3: Add the testing-log entry**

Edit `docs/06-testing/testing-log.md`. Newest-first ordering — prepend at the top a date-stamped entry summarizing M4 changes, the test count delta, manual smoke results, and any open follow-ups. Match the structure of prior entries.

- [ ] **Step 4: Archive prior snapshot**

```bash
git mv docs/07-history/state/2026-05-13.md docs/07-history/state/archive/2026-05-13.md
```

- [ ] **Step 5: Write the new state snapshot**

Create `docs/07-history/state/2026-05-14.md`. Use `docs/07-history/state/archive/2026-05-13.md`'s structure verbatim: HEAD SHA + suite count + summary of "what shipped today" (M4 commits) + "what does not work / known gaps for M5+" (with permission modal, sub-agent scheduler, etc.) + behavioral notes. Pull the milestone status from the spec.

- [ ] **Step 6: Update the boot-doc pointers**

Edit `CLAUDE.md` and `AGENTS.md`. Find the "Session boot" section and change item 3 from:
```
3. `docs/07-history/state/archive/2026-05-13.md` — **most recent close-out snapshot**
```
to:
```
3. `docs/07-history/state/2026-05-14.md` — **most recent close-out snapshot** (Phase 16.1 M4 shipped). Read this BEFORE the build plan to know what shipped, what's open in the backlog, and where to start. Replaced each session.
```

Update the Documentation Index section the same way — `docs/07-history/state/2026-05-14.md` becomes the canonical row; `docs/07-history/state/archive/2026-05-13.md` joins the archive list. Update the "Phases — where we are" section to reflect M4 close.

- [ ] **Step 7: Add the M4 ADR to DECISIONS.md**

Append a short ADR stub for the hydrate-then-subscribe pattern:

```markdown
## ADR M4-01 — Hydrate-then-subscribe for `--resume --ui tui`

Decision: TUI fetches prior message backlog via `GET /sessions/:id/messages` before subscribing to the SSE stream. Discarded alternative: embedding the backlog in a `session_resumed` SSE event.

Rationale: keeps SSE lean (live events only), lets the HTTP fetch retry/paginate independently, matches the `loadMessages()` SessionDb API shape, and fits the Elm-loop better (a single `messagesFetchedMsg` is cleaner than parsing variable-shape backlog from SSE).

Status: implemented (M4, commits TBD).
```

- [ ] **Step 8: Run the full test suites**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: lint + typecheck clean (the 2 pre-existing `shellSemantics.ts` warnings are unchanged baseline). Unit test count grows by ~25 (Task 1: 3, Task 2: 3, Task 3: 4, Task 4: 1, Task 5: 3, Task 6: 3, Task 7: 2, Task 8: 7, Task 10: 1). New total: ~1866/1866.

Run: `cd packages/tui && go test ./...`
Expected: all Go tests pass; the 3 t.Skip'd cases from M3 remain skipped.

- [ ] **Step 9: Run semantic suite filter**

Per CLAUDE.md's mapping (touching `src/server/runtime.ts`, `src/cli/`, and `src/server/routes/`), run:

`bun run test:semantic`

Wait for completion. Expected: all cases pass; no regressions. Log the run + result in testing-log if non-trivial.

- [ ] **Step 10: Commit docs**

```bash
git add docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md docs/03-cli-reference/usage.md docs/06-testing/testing-log.md docs/07-history/state/2026-05-14.md docs/07-history/state/archive/2026-05-13.md CLAUDE.md AGENTS.md DECISIONS.md
git commit -m "docs(state): 2026-05-14 close-out — Phase 16.1 M4 shipped

Flips the three M4 prereq checkboxes (Session DB persistence, preflight,
CLI flag forwarding). New state snapshot supersedes 2026-05-13. usage.md
documents the --ui tui flag-coverage matrix. ADR M4-01 records the
hydrate-then-subscribe decision."
```

- [ ] **Step 11: Push + sov upgrade**

```bash
git push origin master
sov upgrade
```

`sov upgrade` triggers the postinstall hook that rebuilds `bin/sov-tui` from the new Go source.

- [ ] **Step 12: Manual visual smoke**

Run each of the following against the user's live `~/.harness/`:

1. **Fresh persistent session** — `sov --ui tui`. Type "Say hello in 5 words." Hit ENTER. Expected: response streams, `─ turn complete` marker appears. ESC. Run `sqlite3 ~/.harness/sessions.db "SELECT id, role FROM messages ORDER BY id DESC LIMIT 4;"` — expect 2 rows for this turn (1 user + 1 assistant).

2. **Resume** — note the session id from step 1's stderr line (`sov: tui server listening on ... session=<id>`). Run `sov --resume <id> --ui tui`. Expected: transcript pre-populated with the prior "Say hello..." exchange before the prompt accepts input. Type a follow-up. Verify it appends to the same session row (`sqlite3` query again — should see 4 messages).

3. **Resume with unknown id** — `sov --resume 00000000-0000-0000-0000-000000000000 --ui tui`. Expected: stderr "session not found" + non-zero exit, no server start.

4. **Preflight pass** — `sov --ui tui`. Expected: no extra latency vs. M3 (preflight is one cheap call). Verify by stderr line "tui server listening..." appearing promptly.

5. **Preflight skip** — `sov --no-preflight --ui tui`. Expected: same as 4, no behavior change observable. Add a temporary `process.stderr.write('[preflight] skipped\n')` debug line in runtime.ts if needed to confirm; remove before commit.

6. **`--no-cache`** — `sov --no-cache --ui tui`. Expected: turn runs identically; provider call uses no cache markers.

7. **`--max-tokens 100`** — `sov --max-tokens 100 --ui tui`. Type "Tell me a long story." Expected: response truncates at the small max; `turn_complete` event's `finishReason` should reflect `max_tokens`.

8. **Deferred-flag warning** — `sov --transcript /tmp/t.jsonl --ui tui`. Expected: stderr line "sov: --transcript is not yet supported with --ui tui (targeting milestone M7); continuing without it." Then TUI launches normally.

9. **Legacy-input hard error** — `sov --legacy-input --ui tui`. Expected: stderr error + exit 2; no TUI launch.

10. **`--db <custom path>`** — `sov --db /tmp/m4-custom.db --ui tui`. Type something. ESC. `sqlite3 /tmp/m4-custom.db "SELECT COUNT(*) FROM messages;"` — expect ≥ 2.

11. **Legacy REPL still works** — `sov --ui repl` (or bare `sov`). Expected: splash, status footer, `/sessions` lists today's TUI sessions, `/quit` works.

- [ ] **Step 13: Log the manual smoke**

Append to `docs/06-testing/testing-log.md` (under the M4 entry from Step 3): a bulleted list summarizing the 11 manual checks + their outcomes. Commit.

```bash
git add docs/06-testing/testing-log.md
git commit -m "docs(testing-log): M4 manual smoke complete (11 scenarios green)"
git push origin master
```

---

## Self-Review

**Spec coverage check.** M4 owns three subsystems per `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §10 row:
- **Session DB persistence** → Task 1 (on-disk DB + cleanup) + Task 2 (resume validation) + Task 3 (messages route) + Task 4 (saveMessage during turn) + Task 9 (TUI hydrate) — covered end-to-end.
- **Preflight checks** → Task 5 (option) + Task 6 (execution) + Task 7 (error surfacing in launcher) — covered.
- **Full CLI flag forwarding** → Task 7 (forward supported flags) + Task 8 (warn/error on deferred flags) — covered. The usage.md table in Task 11 makes the coverage matrix explicit.

The "3 prereq boxes flipped" in spec §10 is operationalized in Task 11. The "spec/CLAUDE.md/state-snapshot update if applicable, prereq checkbox(es) flipped, testing-log entry, commit + push, sov upgrade if runtime-affecting" close-out checklist from §10 is operationalized across Task 11 steps.

**Placeholder scan.** No `TBD`/`TODO`/"implement later"/"add appropriate error handling"/"similar to Task N" references in the task bodies. Test code is concrete, file paths are exact, commands have expected output. The only forward-looking placeholders are the M5+ scope-outs in the architecture section, which are explicit (and they are deferrals, not unfilled implementation gaps).

**Type consistency.** `RuntimeOptions` fields added across tasks: `dbPath` (T1), `resumeId` (T2), `maxTokens` (T5), `preflight` (T5). `Runtime` fields added: `resumeId` (T2), `maxTokens` (T5). Used consistently in `tuiLauncher.ts` (T7) — option keys passed to `buildRuntime` are `bundleRoot`, `provider`, `model`, `permissionMode`, `maxTokens`, `dbPath`, `resumeId`, `cacheEnabled`, `preflight`. Error classes: `SessionNotFoundError` (T2) and `PreflightError` (T6) — same module `src/server/errors.ts`. Go types: `StoredMessage` / `StoredContentBlock` / `FetchMessages` defined in T9, used in T9 only. Consistent.

**One known coupling between tasks worth flagging.** Task 6's preflight test requires Task 5's MockProvider extension to be in place (the `MockProvider.preflightShouldFail` static was added in T5's scope but only used by T6). Both tasks share `src/providers/mock.ts` edits — when executed sequentially, T5's commit lands the static + counter wiring; T6's commit consumes them. If executed in parallel via subagents, the file conflict is real — execute T5 before T6.

The plan can run sequentially top-to-bottom or via subagent-driven-development with the T5→T6 dependency declared. Tasks 9 (Go) is independent of 1-8 (TS) once Task 3 ships (the route the Go side fetches from), so 9 can run in parallel with 4-8 once 3 is in.

---

Plan complete and saved to `plans/2026-05-14-phase-16-1-m4-critical-correctness.md`.
