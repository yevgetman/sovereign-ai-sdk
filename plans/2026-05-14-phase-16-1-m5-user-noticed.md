# Phase 16.1 M5 — User-Noticed Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Wire three subsystems — **hooks** (PreToolUse / PostToolUse / UserPromptSubmit / Stop), **permission modal** (interactive consent replaces the M3 deny-placeholder), and **sub-agent scheduler** (AgentTool + task_create delegating to bounded children) — into the Phase 16.1 split-process architecture. Three prereq boxes flip in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`. `--ui tui` reaches feature parity with terminalRepl on the surfaces a user notices missing first.

**Architecture:** Server-side wiring extends `RuntimeOptions` / `Runtime` (the M4 pattern). The permission round-trip introduces one new module (`src/server/approvalQueue.ts`) and one new route (`POST /sessions/:id/approvals/:requestId`). The Go TUI gains one new component (`packages/tui/internal/components/permission.go`) plus an `app.go` event handler that replaces the M3 warning-only `permission_request` branch. Sub-agent scheduler is server-side only; the M9 visual polish milestone owns any "child running" status-line indicator.

**Tech Stack:** TS / Bun (server), Hono routes, `bun:test`; Go 1.24 / Bubble Tea (client), `teatest` for snapshot tests. No new dependencies introduced.

**Spec references:**
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §5 (permission round-trip), §10 (M5 row), §13 (open Qs deferred to plan)
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` rows 1 (Hooks), 3 (Permission prompt UI), 4 (Sub-agent scheduler)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4 (terminalRepl untouched; coexistence; audit before flip)
- `plans/2026-05-14-phase-16-1-m4-critical-correctness.md` — M4 plan for the wiring-into-server pattern this milestone repeats

**Scope guard — what M5 does NOT do:**
- No status-line "child running" indicator. The scheduler wires correctly; the visible widget is M9.
- No interactive consent UI for new hook commands inside the TUI. M5 uses a non-interactive denial when a hook command isn't in `~/.harness/shell-hooks-allowlist.json`; users pre-consent via `sov --ui repl` once.
- No configurable approval timeout. M5 hard-codes 60s default (per spec §5); configuration deferred.
- No project-local always-allow persistence through the server. The M3 no-op `recordAlwaysAllow` stays. terminalRepl's allow-list persistence is unchanged and continues to work on `--ui repl`.
- No default-flip. `--ui tui` stays opt-in through M11.
- terminalRepl untouched (Postmortem Rule 1).

---

## Inline Decisions (resolutions of Spec §13 Open Qs for this milestone)

| Decision | Resolution | Rationale |
|---|---|---|
| **M5-01 — Hooks consent in `--ui tui`** | Non-interactive deny when a hook command isn't in `~/.harness/shell-hooks-allowlist.json`. Print `[hook] command not in allowlist — run via 'sov --ui repl' once to grant consent, or pre-populate the allowlist file.` to stderr; the hook is treated as soft-fail (no block). | TTY-bound consent flow lives in `src/hooks/consent.ts`. The server doesn't own a TTY. Wiring an interactive consent surface through SSE + TUI is M9 polish, not M5 wiring. Pre-consent via REPL is one-time and well-documented. |
| **M5-02 — Approval timeout** | 60s default (per spec §5). On timeout: `ApprovalQueue.resolveExpired()` resolves the promise with `{ approved: false, reason: 'timeout' }`. Not user-configurable in M5. | Matches spec §5 explicit number. Configuration adds option surface; defer until a user complaint surfaces. |
| **M5-03 — Sub-agent activity indicator** | DEFER to M9. The scheduler is fully wired functionally in M5, but `subagent_active { count }` SSE events + a status-line widget are not added. | Wiring vs. visualization are independent. M9 owns visual polish; bundling status-line widgets into M5 would expand scope by ~3 tasks. |
| **M5-04 — Permission modal style** | Match terminalRepl's `src/ui/modal.ts` style: lipgloss-rendered yellow-bordered box, centered, three lines: tool name, input preview (truncated to one line), `[y]es / [n]o / [a]lways` choices. | Visual consistency between surfaces. Polishing diverges in M9; M5 just needs functional parity. |
| **M5-05 — Server-side `ask()` wiring** | `serverAsk(opts) → Promise<AskResponse>`: generates a `requestId`, calls `approvalQueue.createPending(requestId, 60_000)`, publishes a `permission_request` SSE event onto the per-session bus, awaits the resolver. POST `/sessions/:id/approvals/:requestId` resolves it. | Matches the spec §5 round-trip exactly. No "always allow" persistence in M5 (M3 no-op stays). The `always` choice is forwarded to client-side memory only — same TUI session honors it; restart loses it (parity with terminalRepl behavior pre-Phase-13). |
| **M5-06 — Task lifecycle persistence** | `TaskManager` constructor takes the same `{ store, scheduler }` shape terminalRepl uses; `TaskStore` opens against `runtime.sessionDb` (no separate DB). | Reuses Phase-13.2 persistence. No schema migrations. |

---

## File Structure

### New files

| Path | Responsibility | Approx. LoC |
|---|---|---|
| `src/server/approvalQueue.ts` | `ApprovalQueue` class: `createPending(requestId, timeoutMs)`, `resolve(requestId, response)`, `cancel(requestId)`. Internal `Map<requestId, { resolve, reject, timer }>`. | ~80 |
| `src/server/routes/approvals.ts` | `approvalsRoute(runtime)` returning a Hono sub-router. `POST /sessions/:id/approvals/:requestId` with body `{ approved: boolean, updatedInput?: unknown }` → resolves the queue's promise. | ~60 |
| `tests/server/approvalQueue.test.ts` | Unit tests for ApprovalQueue: pending → resolve, timeout → expire, cancel → reject, double-resolve → no-op. | ~120 |
| `tests/server/approvals.test.ts` | Route tests against an in-process Hono client. POST resolves a pending request; unknown requestId returns 404; resolved-twice returns 410. | ~100 |
| `tests/server/runtime.hooks.test.ts` | `buildRuntime` loads hooksByEvent from settings; hookRunner is present on Runtime; the M5-01 consent strategy is applied (denylist behavior). | ~140 |
| `tests/server/runtime.subagent.test.ts` | `buildRuntime` instantiates SubagentScheduler + LaneSemaphores + write-lock Semaphore + TaskManager; toolContext receives them when `runTurnInBackground` runs. | ~150 |
| `tests/server/turns.hooks.test.ts` | Drive a mock-provider turn with a hooksByEvent fixture; assert PreToolUse fires before the tool; UserPromptSubmit fires before turn 0; Stop fires at terminal. | ~180 |
| `tests/server/turns.permission.test.ts` | Drive a turn where mock-provider issues a Bash call requiring `ask`-mode consent; emit-permission_request → POST /approvals → resolve → tool runs. | ~160 |
| `tests/server/turns.subagent.test.ts` | Drive a turn where mock-provider issues an AgentTool call; scheduler dispatches; child returns; parent continues. | ~180 |
| `packages/tui/internal/components/permission.go` | `Permission` modal component: state (request details), `Update()` (y/n/a keybindings), `View(width, height)` (lipgloss-centered yellow box). | ~120 |
| `packages/tui/internal/components/permission_test.go` | `teatest` snapshot tests: modal renders for a sample request; y submits with `approved: true`; n submits with `approved: false`; a submits with `approved: true, always: true`. | ~140 |

### Modified files

| Path | Modification |
|---|---|
| `src/server/runtime.ts` | (a) Extend `RuntimeOptions` with `hooksByEvent` injection point (for testing); (b) extend `Runtime` with `hookRunner`, `approvalQueue`, `subagentScheduler`, `taskManager`, `laneSemaphores`, `writeLock`; (c) `buildRuntime` constructs all six; (d) `ask()` placeholder replaced with `serverAsk` that uses `approvalQueue` + publishes onto the per-session bus. |
| `src/server/routes/turns.ts` | Pass `hookRunner`, `subagentScheduler`, `taskManager` to `query()` and into `toolContext`; thread `bus.abortSignal` to the hook runner. |
| `src/server/app.ts` | Mount the new `approvalsRoute(runtime)` on the Hono app. |
| `src/server/eventBus.ts` | Add `publishPermissionRequest(requestId, tool, input, reason?)` helper so `serverAsk` doesn't reach into bus internals. (If the helper isn't a natural fit, inline `bus.publish` and skip this change — implementer judgment.) |
| `packages/tui/internal/app/app.go` | Replace the M3 warning-only `permission_request` handler with one that pushes the new `Permission` modal onto a modal stack; key dispatch routes y/n/a to the modal when active; POST result back via new `transport.PostApproval`. |
| `packages/tui/internal/transport/api.go` | Add `PostApproval(ctx, baseURL, sessionID, requestID, body)` HTTP client (mirrors the existing POST /turns helper, if any — implementer may need to create `api.go` if it doesn't exist; current state has `http.go` for FetchMessages but no client for POST). |
| `tests/cli/tuiLauncherIntegration.test.ts` | Extend the M4 integration smoke with three scenarios: hook fires through tuiLauncher → buildRuntime → query path; permission round-trip; AgentTool delegates. |
| `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` | Flip checkboxes for rows 1, 3, 4 with `(M5 — 2026-05-XX)` annotation. |
| `DECISIONS.md` | Add three ADR stubs: M5-01 (non-interactive hooks consent), M5-02 (60s approval timeout), M5-03 (defer activity indicator). |
| `docs/07-history/state/2026-05-15.md` (or whichever date) | New close-out snapshot — supersedes `docs/07-history/state/2026-05-14.md`. |
| `CLAUDE.md` / `AGENTS.md` | Update state-snapshot pointer to the new dated file. Byte-identical mirror invariant preserved. |

---

## Files Touched (by task)

| Task | Modifies | Creates | Tests |
|---|---|---|---|
| T1 | `src/server/runtime.ts` | — | `tests/server/runtime.hooks.test.ts` |
| T2 | `src/server/routes/turns.ts`, `src/server/runtime.ts` (type only) | — | `tests/server/turns.hooks.test.ts` |
| T3 | — | `src/server/approvalQueue.ts` | `tests/server/approvalQueue.test.ts` |
| T4 | `src/server/app.ts` | `src/server/routes/approvals.ts` | `tests/server/approvals.test.ts` |
| T5 | `src/server/runtime.ts` | — | (extends `tests/server/runtime.test.ts`) |
| T6 | `src/server/runtime.ts` | — | `tests/server/runtime.subagent.test.ts` |
| T7 | `src/server/runtime.ts` | — | (extends T6 test file) |
| T8 | `src/server/routes/turns.ts` | — | `tests/server/turns.subagent.test.ts`, `tests/server/turns.permission.test.ts` |
| T9 | `packages/tui/internal/app/app.go`, `packages/tui/internal/transport/api.go` (likely new) | `packages/tui/internal/components/permission.go` | `packages/tui/internal/components/permission_test.go` |
| T10 | `tests/cli/tuiLauncherIntegration.test.ts`, `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `DECISIONS.md`, `docs/07-history/state/<date>.md`, `CLAUDE.md`, `AGENTS.md` | `docs/07-history/state/<date>.md` (new) | (integration extension exercises all three subsystems) |

---

## Task 1: Wire hook runner into `buildRuntime`

**Goal:** `buildRuntime` constructs a `HookRunner` from `hooksByEvent` settings + a server-mode consent checker. The runner is exposed on `Runtime` so the turns route can pass it to `query()`. New hook commands not in the allowlist soft-fail with a clear stderr message (M5-01).

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.hooks.test.ts`

**Spec / inventory pointers:**
- `src/hooks/runner.ts` → `buildHookRunner(opts: BuildHookRunnerOpts): HookRunner`
- `src/hooks/consent.ts` → `buildFileConsentStore(path)`, `buildConsentChecker(opts)`
- `src/config/settings.ts` → `loadHookSettings(opts: { harnessHome, cwd })`
- `src/ui/terminalRepl.ts` lines 42 (loadHookSettings) and 1057-1064 (build pattern) — copy with the consent variant

- [ ] **Step 1: Write the failing test**

Create `tests/server/runtime.hooks.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';

describe('runtime — hookRunner construction', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-hooks-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-hooks-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('exposes hookRunner on Runtime when settings has hooks', async () => {
    const settingsPath = join(tmpHome, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo bash-fired' }],
            },
          ],
        },
      }),
    );
    const allowlistPath = join(tmpHome, 'shell-hooks-allowlist.json');
    writeFileSync(allowlistPath, JSON.stringify({ allowed: ['echo bash-fired'] }));

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.hookRunner).toBeDefined();
    expect(typeof runtime.hookRunner).toBe('function');

    const result = await runtime.hookRunner('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.block).toBe(false);

    await runtime.dispose();
  });

  test('hookRunner is a no-op when settings has no hooks block', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.hookRunner).toBeDefined();
    const result = await runtime.hookRunner('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.block).toBe(false);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/runtime.hooks.test.ts`
Expected: `runtime.hookRunner is undefined` (no property exists on Runtime yet).

- [ ] **Step 3: Implement — extend `RuntimeOptions` / `Runtime`**

In `src/server/runtime.ts`, add the import at the top:

```typescript
import { buildHookRunner } from '../hooks/runner.js';
import { buildConsentChecker, buildFileConsentStore } from '../hooks/consent.js';
import { loadHookSettings } from '../config/settings.js';
import type { HookRunner } from '../hooks/types.js';
```

Add `hookRunner` to the `Runtime` type (after `maxTokens` field):

```typescript
  /** PreToolUse / PostToolUse / UserPromptSubmit / Stop hook runner.
   *  Server-mode: consent gate is non-interactive — commands not in
   *  `~/.harness/shell-hooks-allowlist.json` are denied with a clear
   *  stderr message (M5-01). Always present (no-op when no hooks block). */
  hookRunner: HookRunner;
```

- [ ] **Step 4: Implement — construct hookRunner inside `buildRuntime`**

In `buildRuntime`, after the permission cascade (after the `canUseTool` is built, before the `return { ... }` block), add:

```typescript
  // Hook runner — loads `hooks` block from settings and wires the
  // consent checker against the server-mode policy (M5-01): commands
  // not in the allowlist soft-fail with stderr remediation; we do not
  // pop a TTY prompt because the server doesn't own one.
  const { hooksByEvent } = loadHookSettings({ harnessHome, cwd: opts.cwd });
  const consentStore = buildFileConsentStore(
    join(harnessHome, 'shell-hooks-allowlist.json'),
  );
  const consent = buildConsentChecker({
    store: consentStore,
    // Server-mode: never prompt. If unknown, deny with the message in
    // the stderr log line — implementer should verify buildConsentChecker
    // accepts a `prompt: () => Promise<boolean>` (or similar) that
    // resolves false; if not, pass `null` and rely on the default-deny
    // branch of the consent gate. Read src/hooks/consent.ts before this
    // step to confirm the parameter shape.
    prompt: async () => false,
  });
  const hookRunner = buildHookRunner({
    hooksByEvent,
    consent,
    home: harnessHome,
    logStderr: (msg: string) => {
      process.stderr.write(`[hook] ${msg}\n`);
    },
  });
```

Add `join` to the existing imports (`import { join } from 'node:path';`).

Add `hookRunner` to the returned `Runtime`:

```typescript
  return {
    // ... existing fields ...
    hookRunner,
    dispose: async () => {
      sessionDb.close();
    },
  };
```

- [ ] **Step 5: Run tests — should pass**

Run: `bun test tests/server/runtime.hooks.test.ts`
Expected: 2 passed.

Also run: `bun run lint && bun run typecheck`
Expected: clean (the 2 pre-existing `shellSemantics.ts` warnings stay; no new errors).

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime.ts tests/server/runtime.hooks.test.ts
git commit -m "feat(server): wire hookRunner into buildRuntime (M5 T1)

Server-side hook runner with non-interactive consent (M5-01).
loadHookSettings + buildHookRunner + buildConsentChecker chain
mirrors terminalRepl's wiring; the consent prompt is forced to
deny so the server never blocks on a TTY it doesn't own.
Pre-consent via 'sov --ui repl' once to populate the allowlist."
```

---

## Task 2: Pass `hookRunner` to `query()` in turns route

**Goal:** `runTurnInBackground` forwards `runtime.hookRunner` to `query()` so `UserPromptSubmit` fires before turn 0, `PreToolUse` / `PostToolUse` fire around each tool, and `Stop` fires at terminal.

**Files:**
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.hooks.test.ts`

**Spec / inventory pointers:**
- `src/core/query.ts` lines 78–87 (UserPromptSubmit dispatch), 103–105 (Stop dispatch) — implementer should verify the parameter name `query()` accepts for the hook runner. If the signature is `query({ ..., hookRunner })`, use that key; if the parameter has a different name, follow it. (Read `src/core/query.ts` lines 1–60 at the start of this task to confirm.)

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.hooks.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';

describe('turns route — hooks fire around the turn', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-hooks-turn-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-hooks-turn-cwd-'));
    MockProvider.toolUseMode = false;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    MockProvider.toolUseMode = false;
  });

  test('UserPromptSubmit fires before turn 0 with the user text', async () => {
    // Hook that writes to a file when UserPromptSubmit fires; we assert
    // the file's contents to prove the hook ran.
    const traceFile = join(tmpHome, 'hook-trace.txt');
    const settingsPath = join(tmpHome, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `printf 'fired\\n' > ${traceFile}`,
                },
              ],
            },
          ],
        },
      }),
    );
    // Pre-consent the trace command so the M5-01 deny branch doesn't
    // trip.
    const allowlistPath = join(tmpHome, 'shell-hooks-allowlist.json');
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: [`printf 'fired\\n' > ${traceFile}`] }),
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const create = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const turn = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(turn.status).toBe(202);

    // Wait for the background turn to finish. Empirically a mock-provider
    // turn completes in <50ms; 200ms is well-headroomed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const traceExists = await Bun.file(traceFile).exists();
    expect(traceExists).toBe(true);
    const trace = await Bun.file(traceFile).text();
    expect(trace).toContain('fired');

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/turns.hooks.test.ts`
Expected: test fails because the hook never fires (turns route doesn't pass `hookRunner` to `query()` yet).

- [ ] **Step 3: Implement — pass `hookRunner` through `query()`**

In `src/server/routes/turns.ts`, inside `runTurnInBackground`, locate the `query({ ... })` call and add `hookRunner: runtime.hookRunner` to the parameters object. Place it next to the other infrastructure params (`canUseTool`, `signal`, etc.):

```typescript
    const stream = query({
      provider: runtime.resolvedProvider.transport,
      model: runtime.model,
      messages,
      systemPrompt: runtime.systemSegments,
      tools: runtime.toolPool,
      toolContext: { /* ... */ },
      maxTokens: runtime.maxTokens,
      sessionId,
      cwd: runtime.cwd,
      signal: bus.abortSignal,
      canUseTool: runtime.canUseTool,
      hookRunner: runtime.hookRunner,
    });
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test tests/server/turns.hooks.test.ts`
Expected: 1 passed.

Re-run full suite to confirm no regressions:
```bash
bun test tests/server/
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/turns.ts tests/server/turns.hooks.test.ts
git commit -m "feat(server): pass hookRunner to query() in turns route (M5 T2)

UserPromptSubmit / PreToolUse / PostToolUse / Stop hooks now fire
through the --ui tui surface end-to-end. Test asserts the
UserPromptSubmit hook writes to a trace file when a mock-provider
turn runs through the route handler."
```

---

## Task 3: Define `ApprovalQueue` module

**Goal:** A pure-TS class that manages pending permission-request promises by `requestId`, with a TTL timeout. No HTTP or SSE coupling — just a queue with `createPending` / `resolve` / `cancel`.

**Files:**
- Create: `src/server/approvalQueue.ts`
- Create: `tests/server/approvalQueue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/approvalQueue.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalQueue, type ApprovalResponse } from '../../src/server/approvalQueue.js';

describe('ApprovalQueue', () => {
  let queue: ApprovalQueue;

  beforeEach(() => {
    queue = new ApprovalQueue();
  });

  afterEach(() => {
    queue.disposeAll();
  });

  test('createPending returns a promise that resolves on matching resolve', async () => {
    const pending = queue.createPending('req-1', 1000);
    queue.resolve('req-1', { approved: true });
    const result = await pending;
    expect(result.approved).toBe(true);
  });

  test('createPending resolves with approved:false after timeout', async () => {
    const pending = queue.createPending('req-2', 50);
    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  test('resolve on an unknown requestId is a no-op', () => {
    // Should not throw.
    queue.resolve('does-not-exist', { approved: true });
  });

  test('resolve twice on the same requestId is idempotent (no-op on second call)', async () => {
    const pending = queue.createPending('req-3', 1000);
    queue.resolve('req-3', { approved: true });
    queue.resolve('req-3', { approved: false }); // second call ignored
    const result = await pending;
    expect(result.approved).toBe(true);
  });

  test('cancel rejects the pending promise', async () => {
    const pending = queue.createPending('req-4', 1000);
    queue.cancel('req-4');
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  test('hasPending returns true between create and resolve', () => {
    expect(queue.hasPending('req-5')).toBe(false);
    queue.createPending('req-5', 1000);
    expect(queue.hasPending('req-5')).toBe(true);
    queue.resolve('req-5', { approved: false });
    expect(queue.hasPending('req-5')).toBe(false);
  });

  test('disposeAll cancels every pending request', async () => {
    const p1 = queue.createPending('req-6', 1000);
    const p2 = queue.createPending('req-7', 1000);
    queue.disposeAll();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/approvalQueue.test.ts`
Expected: `ApprovalQueue is not exported from src/server/approvalQueue.ts` (or module-not-found).

- [ ] **Step 3: Implement `ApprovalQueue`**

Create `src/server/approvalQueue.ts`:

```typescript
// Phase 16.1 M5 — permission-request approval queue.
//
// One queue per server instance. Each pending request is keyed by a
// caller-supplied `requestId`; the queue manages the promise lifecycle,
// the timeout timer, and idempotent resolve / cancel semantics.
//
// Coupling: this module knows nothing about HTTP, SSE, or buses. The
// caller (serverAsk + approvals route) emits the SSE event and POSTs
// the resolution; ApprovalQueue is the in-memory rendezvous.

export type ApprovalResponse = {
  approved: boolean;
  /** Optional input override (the user's "ask" callback can rewrite the
   *  tool input before the tool runs — e.g., redact a secret). */
  updatedInput?: unknown;
  /** Set to 'timeout' when the queue itself resolves on TTL expiry. The
   *  approvals route never sets this; only the timer does. */
  reason?: 'timeout';
};

type PendingEntry = {
  resolve: (response: ApprovalResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ApprovalQueue {
  private pending = new Map<string, PendingEntry>();

  /** Register a pending request. Resolves with the response when the
   *  caller calls `resolve(requestId, ...)`. Resolves with
   *  `{ approved: false, reason: 'timeout' }` if `timeoutMs` elapses
   *  first. Rejects if `cancel(requestId)` is called. */
  createPending(requestId: string, timeoutMs: number): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          resolve({ approved: false, reason: 'timeout' });
        }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending request with a user response. Idempotent: the
   *  second call on the same requestId is a no-op. Calls on unknown
   *  requestIds are also no-ops (the caller may have timed out). */
  resolve(requestId: string, response: ApprovalResponse): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(response);
  }

  /** Reject a pending request. Used by server shutdown and explicit
   *  cancellation paths. */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.reject(new Error(`approval request ${requestId} cancelled`));
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Reject every pending request and clear the map. Server shutdown
   *  calls this so in-flight turns don't dangle on a Promise that will
   *  never resolve. */
  disposeAll(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.cancel(requestId);
    }
  }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `bun test tests/server/approvalQueue.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/approvalQueue.ts tests/server/approvalQueue.test.ts
git commit -m "feat(server): ApprovalQueue for permission-request round-trip (M5 T3)

Pure in-memory rendezvous: createPending → resolve / cancel /
timeout. Coupling-free of HTTP or SSE; the approvals route and
serverAsk callback drive it from above. 60s timeout default
per spec §5; on timeout, approved=false."
```

---

## Task 4: Add `POST /sessions/:id/approvals/:requestId` route

**Goal:** A new Hono route that resolves a pending request on the runtime's `ApprovalQueue`. Mounted onto the server app.

**Files:**
- Create: `src/server/routes/approvals.ts`
- Modify: `src/server/app.ts` (mount the route)
- Create: `tests/server/approvals.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/approvals.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('approvals route', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-approvals-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-approvals-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('POST /sessions/:id/approvals/:requestId resolves a pending request', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    // Pre-arm a pending request directly on the queue.
    const pending = runtime.approvalQueue.createPending('test-req-1', 5000);

    const res = await app.request('/sessions/sess-1/approvals/test-req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const resolved = await pending;
    expect(resolved.approved).toBe(true);

    await runtime.dispose();
  });

  test('POST with approved:false resolves with denied response', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const pending = runtime.approvalQueue.createPending('test-req-2', 5000);
    await app.request('/sessions/sess-1/approvals/test-req-2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });

    const resolved = await pending;
    expect(resolved.approved).toBe(false);

    await runtime.dispose();
  });

  test('POST on unknown requestId returns 404', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const res = await app.request('/sessions/sess-1/approvals/does-not-exist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/approvals.test.ts`
Expected: failure with `runtime.approvalQueue is undefined` (Runtime doesn't expose it yet) or 404 on every route (route not mounted yet).

- [ ] **Step 3: Implement `approvalsRoute`**

Create `src/server/routes/approvals.ts`:

```typescript
// Phase 16.1 M5 — permission approvals route.
//
// POST /sessions/:id/approvals/:requestId — body { approved, updatedInput? }
// Resolves a pending ApprovalQueue entry keyed by `requestId`. The session
// id in the path is informational (it lets future multi-session servers
// scope approvals); v1 has one session and one ApprovalQueue per Runtime.

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';

export function approvalsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/approvals/:requestId', async (c) => {
    const requestId = c.req.param('requestId');
    if (!runtime.approvalQueue.hasPending(requestId)) {
      return c.json({ error: 'unknown or expired requestId' }, 404);
    }
    const body = (await c.req.json()) as {
      approved?: boolean;
      updatedInput?: unknown;
    };
    if (typeof body.approved !== 'boolean') {
      return c.json({ error: '`approved` is required (boolean)' }, 400);
    }
    runtime.approvalQueue.resolve(requestId, {
      approved: body.approved,
      ...(body.updatedInput !== undefined ? { updatedInput: body.updatedInput } : {}),
    });
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Mount the route in `app.ts`**

In `src/server/app.ts`, find `buildAppWithRuntime(runtime)` and add:

```typescript
import { approvalsRoute } from './routes/approvals.js';
```

Inside the function body, mount the route alongside the existing ones:

```typescript
app.route('/', approvalsRoute(runtime));
```

(Or whichever pattern the existing routes use — implementer should match the existing mount style. If the existing app uses `app.route('/', turnsRoute(runtime))`, follow the same shape.)

- [ ] **Step 5: Expose `approvalQueue` on Runtime**

In `src/server/runtime.ts`:

(a) Import `ApprovalQueue`:

```typescript
import { ApprovalQueue } from './approvalQueue.js';
```

(b) Add to the `Runtime` type:

```typescript
  /** Permission-request approval queue. The serverAsk callback and the
   *  approvals route both reach into this — the queue is the rendezvous
   *  point between SSE-emitted permission_request events and the TUI's
   *  POST /approvals response. */
  approvalQueue: ApprovalQueue;
```

(c) Instantiate inside `buildRuntime` (after `sessionDb` is opened, before the `return`):

```typescript
  const approvalQueue = new ApprovalQueue();
```

(d) Add to the returned object:

```typescript
  return {
    // ... existing fields ...
    approvalQueue,
    dispose: async () => {
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };
```

- [ ] **Step 6: Run tests — should pass**

```bash
bun test tests/server/approvals.test.ts
bun test tests/server/
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/approvals.ts src/server/app.ts src/server/runtime.ts tests/server/approvals.test.ts
git commit -m "feat(server): POST /sessions/:id/approvals/:requestId route (M5 T4)

ApprovalQueue lives on Runtime; the new route resolves pending
entries. 404 on unknown requestId. 400 when 'approved' is missing.
dispose() cancels in-flight approvals so server shutdown doesn't
leak promises."
```

---

## Task 5: Replace M3 `ask()` placeholder with server-aware version

**Goal:** When `canUseTool` falls through to `ask` mode, the runtime emits an SSE `permission_request` onto the per-session bus and awaits the matching approval. Replaces the M3 "deny placeholder" that always returned `'deny'`.

**Files:**
- Modify: `src/server/runtime.ts`
- Modify: `src/server/eventBus.ts` (optional — add a helper, or inline `publish` from the ask callback)

**Note for the implementer:** This task changes the signature of `buildRuntime` only internally — it does NOT change `RuntimeOptions` or `Runtime` (both have `approvalQueue` from T4). The `ask` closure needs access to the per-session `bus`, but `buildRuntime` runs before any session exists. Solution: `serverAsk` is a *factory* that accepts the bus + sessionId at the moment the turns route is about to call query(). The cleanest factoring: expose a `createServerAsk(bus, sessionId): AskUser` helper from runtime.ts and have the turns route call it just before `query()`. Or: extend `canUseTool` itself so it carries a `setBusContext(bus, sessionId)` method. Implementer judgment — go with whichever fits the existing canUseTool plumbing.

For this plan, we'll take the **factory** approach: `runtime.canUseTool` stays as-is for the no-bus path; the turns route builds a *session-scoped* `canUseTool` that wraps it with a `serverAsk` bound to the bus.

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.permission.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';

describe('turns route — permission round-trip via serverAsk', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-perm-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-perm-cwd-'));
    MockProvider.toolUseMode = true; // bash echo turn
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    MockProvider.toolUseMode = false;
  });

  test('emits permission_request, awaits approval, then continues', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'ask', // force the ask cascade
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const create = await app.request('/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Kick off the turn (will pause on permission_request).
    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'echo hello' }),
    });

    // Subscribe to SSE; collect events until we see permission_request.
    // Then POST approve. The turn should finish with turn_complete.
    // (Pseudocode below — implementer should use the same SSE-consumer
    // helper as turns.test.ts uses; if no helper exists yet, write a
    // small one that reads chunks and parses `event:` / `data:` lines.)
    const events = await readSseUntil(app, sessionId, (ev) =>
      ev.type === 'permission_request' || ev.type === 'turn_complete',
    );
    const permReq = events.find((e) => e.type === 'permission_request');
    expect(permReq).toBeDefined();
    expect(permReq!.tool).toBe('Bash');

    // Approve.
    await app.request(`/sessions/${sessionId}/approvals/${permReq!.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });

    // Wait for turn_complete.
    const finalEvents = await readSseUntil(app, sessionId, (ev) =>
      ev.type === 'turn_complete',
    );
    expect(finalEvents.some((e) => e.type === 'turn_complete')).toBe(true);

    await runtime.dispose();
  });
});

// Helper: read SSE until a predicate matches. Implementer should crib
// from the existing turns.test.ts SSE helper if one exists; otherwise
// inline a minimal parser of `event: <name>\ndata: <json>\n\n` chunks.
async function readSseUntil(
  app: ReturnType<typeof buildAppWithRuntime>,
  sessionId: string,
  pred: (ev: { type: string } & Record<string, unknown>) => boolean,
): Promise<Array<{ type: string } & Record<string, unknown>>> {
  // ... implementer fills in based on existing helper pattern ...
  throw new Error('helper TODO');
}
```

**Note:** the `readSseUntil` helper is the trickiest part of this test. Before writing the test, the implementer should grep `tests/server/` for an existing SSE-reading helper (`tests/server/events.test.ts` likely has one). If found, reuse it. If not, write a small one — the SSE format is `event: <type>\nid: <seq>\ndata: <json>\n\n`.

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/turns.permission.test.ts`
Expected: test fails because `ask` still returns `'deny'` from the M3 placeholder; the Bash tool call is denied, no `permission_request` is emitted, the turn finishes with a denied result.

- [ ] **Step 3: Refactor `runtime.ts` — extract `createServerAsk`**

In `src/server/runtime.ts`:

Add the import for the bus types:

```typescript
import type { ServerEventBus } from './eventBus.js';
import type { AskUser } from '../permissions/types.js';
```

Below the imports, define the helper (export it):

```typescript
/** Build a session-scoped AskUser that bridges the canUseTool `ask`
 *  callback to the SSE event bus + ApprovalQueue. Each invocation
 *  generates a fresh requestId, publishes a permission_request event,
 *  and awaits the matching POST /approvals. Times out at 60s (M5-02)
 *  with `approved: false`. */
export function createServerAsk(
  approvalQueue: ApprovalQueue,
  bus: ServerEventBus,
  sessionId: string,
): AskUser {
  return async (opts) => {
    const requestId = crypto.randomUUID();
    const pending = approvalQueue.createPending(requestId, 60_000);
    bus.publish({
      type: 'permission_request',
      seq: bus.nextSeq(),
      sessionId,
      requestId,
      tool: opts.toolName,
      input: opts.preview,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    const response = await pending;
    if (response.approved) {
      return response.updatedInput !== undefined ? 'always' : 'allow';
      // NOTE: AskResponse enum is 'allow' | 'always' | 'deny'. M5 maps
      // approved=true → 'allow' by default; if the TUI sets a future
      // `always: true` flag we'll add a second pending response field
      // and map it to 'always'. updatedInput piggybacks 'always' for
      // now — implementer should reconcile against AskResponse type.
    }
    return 'deny';
  };
}
```

**Reconcile AskResponse:** the `approved` boolean maps to `'allow'` or `'deny'`. The `always` choice needs a separate flag. Update the ApprovalResponse type:

In `src/server/approvalQueue.ts`, extend `ApprovalResponse`:

```typescript
export type ApprovalResponse = {
  approved: boolean;
  always?: boolean;
  updatedInput?: unknown;
  reason?: 'timeout';
};
```

Update `createServerAsk` accordingly:

```typescript
  return async (opts) => {
    const requestId = crypto.randomUUID();
    const pending = approvalQueue.createPending(requestId, 60_000);
    bus.publish({
      type: 'permission_request',
      seq: bus.nextSeq(),
      sessionId,
      requestId,
      tool: opts.toolName,
      input: opts.preview,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    const response = await pending;
    if (!response.approved) return 'deny';
    return response.always === true ? 'always' : 'allow';
  };
```

Update the approvals route in `src/server/routes/approvals.ts` to accept `always`:

```typescript
    const body = (await c.req.json()) as {
      approved?: boolean;
      always?: boolean;
      updatedInput?: unknown;
    };
    // ... validation ...
    runtime.approvalQueue.resolve(requestId, {
      approved: body.approved,
      ...(body.always === true ? { always: true } : {}),
      ...(body.updatedInput !== undefined ? { updatedInput: body.updatedInput } : {}),
    });
```

- [ ] **Step 4: Wire `serverAsk` into the turns route**

In `src/server/routes/turns.ts`:

Import `createServerAsk` from runtime and `buildCanUseTool` + supporting types:

```typescript
import { createServerAsk } from '../runtime.js';
import { buildCanUseTool } from '../../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../../permissions/redactSecretsTransformer.js';
import { loadPermissionSettings } from '../../config/settings.js';
```

Inside `runTurnInBackground`, before the `query({...})` call, build the session-scoped canUseTool:

```typescript
  // Replace runtime.canUseTool (which carries the M3 deny placeholder)
  // with a session-scoped version that bridges ask() through the bus.
  // The bus is per-session; the queue is per-runtime; the wiring lives
  // here because we need both refs in scope.
  const permissionSettings = loadPermissionSettings({
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
  });
  const sessionAsk = createServerAsk(runtime.approvalQueue, bus, sessionId);
  const baseCanUseTool = buildCanUseTool({
    mode: runtime.permissionMode,
    ask: sessionAsk,
    alwaysAllow: new Set<string>(), // M3 no-op; M5 keeps it (memory only)
    ruleLayers: permissionSettings.layers,
    recordAlwaysAllow: () => { /* no-op in M5 server */ },
  });
  const sessionCanUseTool = wrapCanUseToolWithTransformers(
    baseCanUseTool,
    [redactSecretsTransformer],
  );
```

Pass `sessionCanUseTool` (not `runtime.canUseTool`) to `query()`:

```typescript
      canUseTool: sessionCanUseTool,
```

- [ ] **Step 5: Run tests — should pass**

```bash
bun test tests/server/turns.permission.test.ts
bun test tests/server/  # full server suite
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime.ts src/server/routes/turns.ts src/server/routes/approvals.ts src/server/approvalQueue.ts tests/server/turns.permission.test.ts
git commit -m "feat(server): serverAsk bridges canUseTool to SSE + ApprovalQueue (M5 T5)

Replaces M3 deny-placeholder. Each ask-mode tool call emits a
permission_request event with a fresh requestId; the turn pauses
on the matching ApprovalQueue.createPending() promise; the TUI's
POST /approvals/:requestId resolves it. 60s timeout → denied
(M5-02). The 'always' choice is forwarded into AskResponse but
project-local persistence stays a no-op (parity with M3)."
```

---

## Task 6: Wire `SubagentScheduler` + lane semaphores + write lock into `buildRuntime`

**Goal:** Construct `LaneSemaphores`, the write-path `Semaphore(1)`, and `SubagentScheduler` inside `buildRuntime`. Expose them on `Runtime`.

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.subagent.test.ts`

**Inventory pointers:**
- `src/runtime/scheduler.ts` → `SubagentScheduler(opts: SubagentSchedulerOpts)`
- `src/runtime/laneSemaphores.ts` → `LaneSemaphores`
- `src/runtime/semaphore.ts` → `Semaphore(n)`
- `src/ui/terminalRepl.ts` lines 931–955 — the construction pattern to mirror

- [ ] **Step 1: Write the failing test**

Create `tests/server/runtime.subagent.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('runtime — sub-agent scheduler construction', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-sched-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-sched-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('Runtime exposes subagentScheduler, laneSemaphores, writeLock', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.subagentScheduler).toBeDefined();
    expect(runtime.laneSemaphores).toBeDefined();
    expect(runtime.writeLock).toBeDefined();
    expect(typeof runtime.subagentScheduler.delegate).toBe('function');

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `bun test tests/server/runtime.subagent.test.ts`
Expected: `runtime.subagentScheduler is undefined`.

- [ ] **Step 3: Implement scheduler construction**

In `src/server/runtime.ts`:

Add imports:

```typescript
import { SubagentScheduler } from '../runtime/scheduler.js';
import { LaneSemaphores } from '../runtime/laneSemaphores.js';
import { Semaphore } from '../runtime/semaphore.js';
import type { ChildSessionFactory } from '../runtime/types.js'; // implementer should verify the exact module/symbol; the type may live elsewhere
```

Add to the `Runtime` type:

```typescript
  /** Per-lane concurrency caps used by both the router (single-session
   *  escalations) and the sub-agent scheduler (parent dispatching N
   *  children). One instance shared across both consumers. */
  laneSemaphores: LaneSemaphores;
  /** Single-writer lock for write-capable children. Prevents two
   *  child agents from racing on the same file. */
  writeLock: Semaphore;
  /** Sub-agent scheduler. AgentTool calls scheduler.delegate(...) at
   *  dispatch time. */
  subagentScheduler: SubagentScheduler;
```

Inside `buildRuntime`, after `sessionDb` is opened, construct the trio:

```typescript
  // Sub-agent infrastructure — see terminalRepl.ts:931-955 for the
  // construction pattern. The createChildSession factory and the
  // resolveProvider closure mirror that file's wiring.
  const laneSemaphores = new LaneSemaphores();
  const writeLock = new Semaphore(1);
  const subagentScheduler = new SubagentScheduler({
    agents,
    laneSemaphores,
    writeLock,
    resolveProvider: (providerName, modelName) =>
      resolveProvider(providerName, modelName, { harnessHome }),
    createChildSession: (parentSessionId) => {
      const childSessionId = sessionDb.createSession({
        parentSessionId,
        cwd: opts.cwd,
        provider: resolved.transport.name,
        model: resolved.model,
        bundleRoot,
      });
      return { sessionId: childSessionId };
      // Implementer: verify the exact return shape SubagentScheduler
      // expects — see src/ui/terminalRepl.ts lines 931-955 for the
      // canonical wiring.
    },
    defaultProvider: resolved.transport.name,
    defaultModel: resolved.model,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Other opts: implementer follows terminalRepl precedent (timeouts,
    // per-child trace path, etc.).
  });
```

Add to the returned `Runtime`:

```typescript
  return {
    // ...
    laneSemaphores,
    writeLock,
    subagentScheduler,
    // ...
  };
```

- [ ] **Step 4: Run tests — should pass**

```bash
bun test tests/server/runtime.subagent.test.ts
bun run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime.ts tests/server/runtime.subagent.test.ts
git commit -m "feat(server): wire SubagentScheduler + LaneSemaphores + writeLock (M5 T6)

Mirrors terminalRepl.ts:931-955 construction pattern. The
scheduler + lane caps + write lock are shared via Runtime so
the turns route can plumb them into toolContext at query() time
(T7+T8). createChildSession factory uses sessionDb.createSession
with parent_session_id; resolveProvider is captured as a closure
with the same harnessHome the parent uses."
```

---

## Task 7: Wire `TaskManager` + `TaskStore` into `buildRuntime`

**Goal:** Construct a `TaskManager` over a `TaskStore` backed by `runtime.sessionDb`. Expose on Runtime so `task_create` / `task_list` / `task_get` / `task_output` tools work.

**Files:**
- Modify: `src/server/runtime.ts`
- Modify: `tests/server/runtime.subagent.test.ts` (extend)

**Inventory pointers:**
- `src/tasks/manager.ts` → `TaskManager(opts: { store, scheduler })`
- `src/tasks/store.ts` → `TaskStore` constructor (likely takes `sessionDb`)
- `src/ui/terminalRepl.ts` lines 969–972

- [ ] **Step 1: Extend the failing test**

Append to `tests/server/runtime.subagent.test.ts`:

```typescript
  test('Runtime exposes taskManager wired to sessionDb', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.taskManager).toBeDefined();
    expect(typeof runtime.taskManager.create).toBe('function');
    // The store should be reading from runtime.sessionDb (same instance).
    // No tasks at boot; calling list should return an empty array.
    const tasks = await runtime.taskManager.list();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(0);

    await runtime.dispose();
  });
```

- [ ] **Step 2: Run tests — should fail**

```bash
bun test tests/server/runtime.subagent.test.ts
```

Expected: new test fails on `runtime.taskManager is undefined`.

- [ ] **Step 3: Implement TaskManager construction**

In `src/server/runtime.ts`:

Add imports:

```typescript
import { TaskManager } from '../tasks/manager.js';
import { TaskStore } from '../tasks/store.js';
```

Add to the `Runtime` type:

```typescript
  /** Phase 13.2 task system. AgentTool's parallel cousin: task_create
   *  delegates a turn and persists state to sessionDb so /tasks slash
   *  command can introspect across resumes. */
  taskManager: TaskManager;
```

Inside `buildRuntime`, after the `subagentScheduler` is constructed:

```typescript
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({ store: taskStore, scheduler: subagentScheduler });
```

Add to the returned `Runtime`:

```typescript
  return {
    // ...
    taskManager,
    // ...
  };
```

- [ ] **Step 4: Run tests — should pass**

```bash
bun test tests/server/runtime.subagent.test.ts
```

Expected: all 2 tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime.ts tests/server/runtime.subagent.test.ts
git commit -m "feat(server): wire TaskManager + TaskStore into buildRuntime (M5 T7)

TaskStore reads against runtime.sessionDb; no separate DB. Mirrors
terminalRepl.ts:969-972 construction. /tasks slash command + the
task_create / task_list tools will work end-to-end through --ui tui
once T8 threads the manager through toolContext."
```

---

## Task 8: Thread scheduler + taskManager through `toolContext` in turns route

**Goal:** Populate `toolContext.subagentScheduler`, `toolContext.parentToolPool`, `toolContext.canUseTool`, and `toolContext.taskManager` so AgentTool and Task tools dispatch correctly.

**Files:**
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.subagent.test.ts`

**Inventory pointers:**
- `src/ui/terminalRepl.ts` lines 958–960 — the toolContext wiring pattern

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.subagent.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';

describe('turns route — sub-agent dispatch via AgentTool', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-subagent-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-subagent-cwd-'));
    MockProvider.toolUseMode = false;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    MockProvider.toolUseMode = false;
  });

  test('toolContext receives subagentScheduler + taskManager when query runs', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    // We don't need a full agent dispatch end-to-end — that's covered
    // by the existing scheduler tests in tests/runtime/. Here we just
    // need to verify that the toolContext threaded into query() carries
    // the scheduler + taskManager. The cleanest assertion is to spy on
    // assembleToolPool's invocation arg (or simpler: introspect a tool
    // call that requires the scheduler and confirm it doesn't throw
    // "no scheduler available").
    //
    // For M5, the implementer should pick whichever approach is cleanest
    // given existing test scaffolding. The simplest: use the MockProvider's
    // toolUseMode to issue an AgentTool call and verify the child session
    // is created in sessionDb.

    // Sketch:
    //  1. Set MockProvider to issue an AgentTool call instead of Bash
    //     (extend MockProvider if needed).
    //  2. POST /sessions, then POST /turns.
    //  3. Wait for turn_complete.
    //  4. Query runtime.sessionDb for sessions where parent_session_id =
    //     the parent — expect at least one child row.

    // Implementer fills in the body once MockProvider gains an
    // 'agentMode' toggle similar to toolUseMode. If that extension is
    // out of scope, downgrade this test to just verify that
    // toolContext.subagentScheduler is defined when runTurnInBackground
    // is called (via a test-only export of the toolContext-builder
    // helper, or via spying on assembleToolPool).

    await runtime.dispose();
  });
});
```

**Implementer note:** the cleanest version of this test extends MockProvider with an `agentMode` flag that emits an `agent_runner` tool_use block, then asserts that runtime.sessionDb.getChildren(parentSessionId) returns ≥ 1 row. Estimate: ~30 LoC of MockProvider extension + the test body. If that's too much, downgrade to a wiring test (toolContext receives the scheduler — assert via a debug export or assembleToolPool spy).

- [ ] **Step 2: Run tests — should fail**

Expected: scheduler unavailable in toolContext.

- [ ] **Step 3: Update `toolContext` in `runTurnInBackground`**

In `src/server/routes/turns.ts`, inside `runTurnInBackground`'s `query({...})` call, expand `toolContext`:

```typescript
      toolContext: {
        cwd: runtime.cwd,
        sessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
        ...(runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}),
        // M5 additions: AgentTool reads subagentScheduler at dispatch
        // time; task_create reads taskManager. parentToolPool is the
        // current tool pool so children inherit (or filter from) it.
        // canUseTool here is the session-scoped one built above in T5.
        subagentScheduler: runtime.subagentScheduler,
        taskManager: runtime.taskManager,
        parentToolPool: runtime.toolPool,
        canUseTool: sessionCanUseTool,
      },
```

- [ ] **Step 4: Run tests — should pass**

```bash
bun test tests/server/turns.subagent.test.ts
bun test tests/server/  # full suite
bun run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/turns.ts tests/server/turns.subagent.test.ts
git commit -m "feat(server): thread scheduler + taskManager through toolContext (M5 T8)

AgentTool + task_create + task_list + task_get + task_output now
work through --ui tui. toolContext mirrors terminalRepl.ts:958-960
so child-session lineage flows the same way (parent_session_id in
schema-v3). parentToolPool also wired so AgentTool can filter from
the parent's pool when delegating."
```

---

## Task 9: Go TUI permission modal — component + handler + HTTP client

**Goal:** A Bubble Tea `Permission` component renders a centered yellow modal when a `permission_request` SSE event arrives. `y` / `n` / `a` POSTs the result via a new `transport.PostApproval` helper. Replaces the M3 warning-only handler.

**Files:**
- Create: `packages/tui/internal/components/permission.go`
- Create: `packages/tui/internal/components/permission_test.go`
- Modify: `packages/tui/internal/app/app.go` (route key dispatch to modal when active)
- Modify or create: `packages/tui/internal/transport/api.go` (the `PostApproval` HTTP helper; if no `api.go` exists today, create it. The M3/M4 code POSTs from inside `app.go::submitTurn` directly — that's fine to keep, but the approval POST is cleaner as a transport helper.)

- [ ] **Step 1: Write the failing test**

Create `packages/tui/internal/components/permission_test.go`:

```go
package components_test

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/components"
)

func TestPermissionModal_RendersToolNameAndChoices(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{
		RequestID: "req-1",
		Tool:      "Bash",
		Input:     "git status",
		Reason:    "",
	})
	out := p.View(80, 24)
	if !strings.Contains(out, "Bash") {
		t.Fatalf("expected tool name in output:\n%s", out)
	}
	if !strings.Contains(out, "git status") {
		t.Fatalf("expected input preview in output:\n%s", out)
	}
	if !strings.Contains(out, "[y]") {
		t.Fatalf("expected [y] choice in output:\n%s", out)
	}
	if !strings.Contains(out, "[N]") {
		t.Fatalf("expected default [N] choice in output:\n%s", out)
	}
	if !strings.Contains(out, "[a]") {
		t.Fatalf("expected [a] choice in output:\n%s", out)
	}
}

func TestPermissionModal_YApprovesAndProducesSubmitMsg(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{
		RequestID: "req-2",
		Tool:      "Bash",
		Input:     "ls",
	})
	updated, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if cmd == nil {
		t.Fatal("expected a Cmd carrying the submit message")
	}
	if !updated.Done() {
		t.Fatal("expected modal to mark itself done after y")
	}
	msg := cmd()
	submit, ok := msg.(components.PermissionSubmitMsg)
	if !ok {
		t.Fatalf("expected PermissionSubmitMsg, got %T", msg)
	}
	if submit.RequestID != "req-2" {
		t.Fatalf("expected requestID 'req-2', got %q", submit.RequestID)
	}
	if !submit.Approved {
		t.Fatal("expected Approved=true for y")
	}
	if submit.Always {
		t.Fatal("expected Always=false for y")
	}
}

func TestPermissionModal_NDeniesAndProducesSubmitMsg(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-3"})
	updated, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if !updated.Done() {
		t.Fatal("expected done after n")
	}
	submit := cmd().(components.PermissionSubmitMsg)
	if submit.Approved {
		t.Fatal("expected Approved=false for n")
	}
}

func TestPermissionModal_AApprovesWithAlways(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-4"})
	_, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	submit := cmd().(components.PermissionSubmitMsg)
	if !submit.Approved {
		t.Fatal("expected Approved=true for a")
	}
	if !submit.Always {
		t.Fatal("expected Always=true for a")
	}
}

func TestPermissionModal_EnterDefaultsToDeny(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-5"})
	_, cmd := p.Update(tea.KeyMsg{Type: tea.KeyEnter})
	submit := cmd().(components.PermissionSubmitMsg)
	if submit.Approved {
		t.Fatal("expected Enter to default to deny")
	}
}
```

- [ ] **Step 2: Run tests — should fail**

```bash
cd packages/tui && go test ./internal/components/...
```

Expected: `undefined: components.NewPermission`.

- [ ] **Step 3: Implement `Permission` component**

Create `packages/tui/internal/components/permission.go`:

```go
// Package permission modal — renders a centered yellow-bordered box
// when canUseTool falls through to ask mode. Replaces the M3 warning.
//
// Visual style matches src/ui/modal.ts (terminalRepl's modal) for
// parity between surfaces. M5-04: yellow border, tool name, input
// preview (truncated), three choices [y]/[N]/[a].
//
// Key bindings (M5-04):
//   y        → approve (allow once)
//   n / Esc  → deny (also the default)
//   a        → approve + always (deny remains the only "memory" choice
//              we don't persist in M5)
//   Enter    → deny (the default; matches the [N] highlight)

package components

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// PermissionRequest is the modal's input — extracted from a
// permission_request SSE event.
type PermissionRequest struct {
	RequestID string
	Tool      string
	Input     string
	Reason    string
}

// PermissionSubmitMsg is emitted into the Bubble Tea event loop when
// the user makes a choice. The parent (app.go) catches it and POSTs
// to /sessions/:id/approvals/:requestID.
type PermissionSubmitMsg struct {
	RequestID string
	Approved  bool
	Always    bool
}

type Permission struct {
	req  PermissionRequest
	done bool
}

func NewPermission(req PermissionRequest) Permission {
	return Permission{req: req}
}

func (p Permission) Done() bool { return p.done }

func (p Permission) Update(msg tea.Msg) (Permission, tea.Cmd) {
	keyMsg, ok := msg.(tea.KeyMsg)
	if !ok {
		return p, nil
	}
	switch keyMsg.Type {
	case tea.KeyEnter:
		return p.deny()
	case tea.KeyEsc:
		return p.deny()
	}
	switch keyMsg.String() {
	case "y", "Y":
		p.done = true
		return p, p.emit(true, false)
	case "n", "N":
		return p.deny()
	case "a", "A":
		p.done = true
		return p, p.emit(true, true)
	}
	return p, nil
}

func (p Permission) deny() (Permission, tea.Cmd) {
	p.done = true
	return p, p.emit(false, false)
}

func (p Permission) emit(approved, always bool) tea.Cmd {
	requestID := p.req.RequestID
	return func() tea.Msg {
		return PermissionSubmitMsg{
			RequestID: requestID,
			Approved:  approved,
			Always:    always,
		}
	}
}

func (p Permission) View(width, height int) string {
	if width == 0 {
		return ""
	}
	// Truncate input preview to a single line, 60 chars max.
	preview := p.req.Input
	if len(preview) > 60 {
		preview = preview[:57] + "..."
	}
	preview = strings.ReplaceAll(preview, "\n", " ")

	yellow := lipgloss.NewStyle().Foreground(lipgloss.Color("#e5c07b"))
	bold := yellow.Copy().Bold(true)
	dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
	defaultChoice := bold.Copy().Underline(true)

	lines := []string{
		bold.Render("permission required"),
		"",
		dim.Render("tool   ") + lipgloss.NewStyle().Bold(true).Render(p.req.Tool),
		dim.Render("input  ") + preview,
	}
	if p.req.Reason != "" {
		lines = append(lines, dim.Render("reason ")+dim.Render(p.req.Reason))
	}
	lines = append(lines,
		"",
		fmt.Sprintf("%s %s   %s %s   %s %s",
			yellow.Render("[y]"), dim.Render("allow"),
			defaultChoice.Render("[N]"), dim.Render("deny"),
			yellow.Render("[a]"), dim.Render("always"),
		),
	)

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#e5c07b")).
		Padding(0, 2).
		Render(strings.Join(lines, "\n"))

	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}
```

- [ ] **Step 4: Run component tests — should pass**

```bash
cd packages/tui && go test ./internal/components/... -run TestPermission
```

Expected: 5 passed.

- [ ] **Step 5: Wire into `app.go`**

In `packages/tui/internal/app/app.go`:

Add the modal field to `Model`:

```go
type Model struct {
	// ... existing fields ...
	permission *components.Permission // active modal; nil when not visible
}
```

Replace the M3 warning-only `permission_request` branch in `handleEvent`:

```go
	case "permission_request":
		pr, err := transport.DecodePermissionRequest(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		modal := components.NewPermission(components.PermissionRequest{
			RequestID: pr.RequestID,
			Tool:      pr.Tool,
			Input:     fmt.Sprintf("%v", pr.Input),
			Reason:    pr.Reason,
		})
		m.permission = &modal
```

Route key dispatch to the modal in `Update`. Add a check at the very top of the `tea.KeyMsg` branch, before the existing key handling:

```go
	case tea.KeyMsg:
		if m.permission != nil && !m.permission.Done() {
			updated, cmd := m.permission.Update(msg)
			m.permission = &updated
			return m, cmd
		}
		// ... existing key handling unchanged ...
```

Handle `PermissionSubmitMsg`:

```go
	case components.PermissionSubmitMsg:
		m.permission = nil
		return m, m.postApproval(msg)
```

Add the `postApproval` method on `Model`:

```go
func (m Model) postApproval(submit components.PermissionSubmitMsg) tea.Cmd {
	return func() tea.Msg {
		body, err := json.Marshal(map[string]any{
			"approved": submit.Approved,
			"always":   submit.Always,
		})
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		url := fmt.Sprintf("%s/sessions/%s/approvals/%s", m.baseURL, m.sessionID, submit.RequestID)
		req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return turnSubmitErrMsg{err: fmt.Errorf("approval POST returned %d", resp.StatusCode)}
		}
		return nil
	}
}
```

Modify `View()` to overlay the modal when active:

```go
func (m Model) View() string {
	if m.height == 0 {
		return ""
	}
	base := m.transcript.View() + "\n" + m.prompt.View() + "\n" + m.statusLine.View()
	if m.permission != nil && !m.permission.Done() {
		// Overlay the modal centered over the whole frame. lipgloss
		// Place inside the modal handles the centering; we just return
		// the modal output (suppressing the base layer for v1 to keep
		// rendering simple; later milestones may composite both).
		return m.permission.View(m.width, m.height)
	}
	return base
}
```

- [ ] **Step 6: Run app tests — should pass**

```bash
cd packages/tui && go test ./internal/app/... -run TestApp
go test ./internal/components/... -run TestPermission
```

Expected: all existing app tests still pass; new permission tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/tui/internal/components/permission.go packages/tui/internal/components/permission_test.go packages/tui/internal/app/app.go
git commit -m "feat(tui): interactive permission modal replaces M3 warning (M5 T9)

New Permission component: yellow box, tool name + input preview,
[y]/[N]/[a] choices. app.go pushes the modal on permission_request
events; suppresses other key input while active; POSTs the result
to /sessions/:id/approvals/:requestId on user choice. Esc + Enter
default to deny."
```

---

## Task 10: Integration smoke + close-out

**Goal:** Extend the M4 `tuiLauncherIntegration.test.ts` so the three M5 subsystems are exercised end-to-end through `runTuiLauncher`. Flip prereq checkboxes. Add ADR stubs. Update state snapshot. Mirror CLAUDE.md / AGENTS.md.

**Files:**
- Modify: `tests/cli/tuiLauncherIntegration.test.ts`
- Modify: `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` (flip rows 1, 3, 4)
- Modify: `DECISIONS.md` (3 ADR stubs)
- Create: `docs/07-history/state/2026-05-XX.md` (whichever date M5 closes; replaces 2026-05-14.md)
- Modify: `CLAUDE.md` and `AGENTS.md` (state-snapshot pointer)
- Modify: `docs/06-testing/testing-log.md` (M5 close-out entry)

- [ ] **Step 1: Extend `tuiLauncherIntegration.test.ts`**

Add three scenarios (one per subsystem) modeled after the existing M4 integration smoke. Each scenario:
1. Sets up `HARNESS_HOME` + bundle.
2. Configures a hooks/permission/scheduler fixture.
3. Spawns the real `runTuiLauncher` against a stub TUI binary.
4. Asserts the side-effect (hook fired / approval round-tripped / child session created).

Pseudocode (the implementer fills in the body using the existing integration test's helpers):

```typescript
describe('tuiLauncher integration smoke — M5 subsystems', () => {
  test('hooks fire end-to-end through runTuiLauncher', async () => {
    // 1. Write a settings.json with a UserPromptSubmit hook.
    // 2. Pre-consent the hook command.
    // 3. Spawn runTuiLauncher with the stub TUI.
    // 4. POST a turn through the launched server.
    // 5. Wait for turn_complete on SSE.
    // 6. Assert the hook's side-effect file exists.
  });

  test('permission round-trip resolves through the launched server', async () => {
    // 1. permissionMode='ask' in opts.
    // 2. Spawn runTuiLauncher.
    // 3. POST a turn (MockProvider.toolUseMode=true).
    // 4. Read SSE until permission_request.
    // 5. POST /approvals/:requestId with approved=true.
    // 6. Read SSE until turn_complete.
  });

  test('AgentTool dispatches a child session through the launched runtime', async () => {
    // 1. Configure MockProvider (or a custom one) to issue AgentTool.
    // 2. Spawn runTuiLauncher.
    // 3. POST a turn.
    // 4. Wait for turn_complete.
    // 5. Open the sessions DB and assert getChildren(parentSessionId) ≥ 1.
  });
});
```

- [ ] **Step 2: Run the extended integration test**

```bash
bun test tests/cli/tuiLauncherIntegration.test.ts
```

Expected: green.

- [ ] **Step 3: Flip prereq checkboxes**

In `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`:

```
| 1 | `[x]` (M5 — 2026-05-XX) | **Hooks system** | ... |
| 3 | `[x]` (M5 — 2026-05-XX) | **Permission prompt UI** | ... |
| 4 | `[x]` (M5 — 2026-05-XX) | **Sub-agent scheduler** | ... |
```

Substitute the actual close-out date.

- [ ] **Step 4: Add ADR stubs to `DECISIONS.md`**

Append three short stubs (one paragraph each) matching the project's existing ADR style:

- **M5-01 — Non-interactive hooks consent in `--ui tui`.**
- **M5-02 — Approval timeout default 60s.**
- **M5-03 — Defer sub-agent activity indicator to M9.**

Each ADR references this plan + the spec §13 row.

- [ ] **Step 5: Write the close-out state snapshot**

Create `docs/07-history/state/2026-05-XX.md` (substitute close-out date). Use `docs/07-history/state/2026-05-14.md` as the structural template: HEAD SHA + suite count + "what shipped" + "what's open for M6+" + behavioral notes.

Move the previous snapshot to `docs/07-history/state/archive/2026-05-14.md`.

- [ ] **Step 6: Update CLAUDE.md / AGENTS.md state-snapshot pointer**

In `CLAUDE.md`, update the Session boot item 3 to point at the new snapshot date. Same in the doc-index "Current state" row. Then `cp CLAUDE.md AGENTS.md` and verify `diff` is empty.

- [ ] **Step 7: Update testing log**

Append to `docs/06-testing/testing-log.md` (newest at top) summarizing the M5 close-out: scope, commands run (lint / typecheck / test / go test), suite delta (1873 → 1873 + N new tests), and any regressions surfaced + fixed.

- [ ] **Step 8: Run the full pre-commit gate**

```bash
bun run lint
bun run typecheck
bun run test
cd packages/tui && go test ./...
```

Expected: all green. Lint should still report only the 2 pre-existing `shellSemantics.ts` warnings.

- [ ] **Step 9: Commit + push**

```bash
git add tests/cli/tuiLauncherIntegration.test.ts docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md DECISIONS.md docs/07-history/state/2026-05-XX.md docs/07-history/state/archive/2026-05-14.md CLAUDE.md AGENTS.md docs/06-testing/testing-log.md
git commit -m "docs(state): M5 close-out — 3 prereq boxes flipped (M5 T10)

Snapshot at HEAD <SHA>. Suite green; manual smoke pending user."
git push origin master
sov upgrade
```

- [ ] **Step 10: Manual smoke (user)**

User-facing manual smoke checklist for M5 (added to the state snapshot):

1. **Hooks fire.** With a `UserPromptSubmit` hook in `~/.harness/settings.json` (e.g. `echo "$(date)" >> /tmp/sov-hook-trace`), launch `sov --ui tui`, send any prompt; verify `/tmp/sov-hook-trace` has a new line.
2. **Permission modal renders.** With `permissionMode: ask` in `~/.harness/config.json`, ask the agent to run any non-read-only tool (`Bash("ls")`); verify the yellow modal appears centered, with the tool name + input preview. `y` allows; `n`/Esc denies.
3. **AgentTool delegates.** Ask the agent to use the `explore` subagent (`Use the explore agent to summarize src/server/`); verify the child session runs and returns a summary without errors.

---

## Self-Review

**Spec coverage:**
- Spec §10 M5 row says "Hooks fire around tool calls" → T1+T2 cover construction + dispatch; T10 step-1 covers integration smoke. ✓
- Spec §10 M5 row says "permission modal replaces readline asker" → T3+T4+T5 cover server-side; T9 covers Go TUI; T8 (toolContext) carries the session-scoped canUseTool. ✓
- Spec §10 M5 row says "sub-agent scheduler honored (per-lane semaphores, write-lock, per-child timeout)" → T6+T7+T8 cover construction + dispatch. Per-child timeout flows through SubagentScheduler's existing internal handling (terminalRepl precedent at line 931-955); no new wiring needed in M5. ✓
- Spec §5 permission round-trip with 60s timeout → T3 (ApprovalQueue) + T4 (route) + T5 (serverAsk) + decision M5-02. ✓
- Postmortem Rule 1 (terminalRepl untouched) — no terminalRepl edits in any task. ✓
- Postmortem Rule 3 (audit before flip) — T10 step-1 integration smoke covers all three subsystems; manual smoke (T10 step-10) verifies user-visible parity. ✓

**Placeholder scan:**
- One pseudocode block in T5 step-1 (`readSseUntil` helper) — flagged with implementer note to crib from existing test helper or write inline. Acceptable.
- One pseudocode block in T8 step-1 (the subagent dispatch test body) — flagged with implementer note for two acceptable approaches (extend MockProvider or downgrade to a wiring test).
- One pseudocode block in T10 step-1 (the integration scenarios) — modeled on the existing M4 integration test pattern; implementer fills in using existing helpers.

**Type consistency:**
- `HookRunner` type from `src/hooks/types.ts` flows through T1's Runtime extension to T2's `query()` call. ✓
- `ApprovalQueue` / `ApprovalResponse` introduced in T3, used in T4 (route), T5 (serverAsk). The `always` flag is added to `ApprovalResponse` in T5 step-3, consistent with the approvals route + AskResponse mapping. ✓
- `SubagentScheduler` / `LaneSemaphores` / `Semaphore` / `TaskManager` / `TaskStore` — names match `src/runtime/` and `src/tasks/` modules per the inventory. ✓
- Go types: `PermissionRequest` / `PermissionSubmitMsg` introduced in T9; used in `app.go` to bridge SSE → modal → POST. ✓

**Implementer-flagged risks:**
- T1: `buildConsentChecker`'s exact parameter shape — the implementer should read `src/hooks/consent.ts` before step 3.
- T5: The `AskUser` callback signature — needs verification against `src/permissions/types.ts`.
- T5: The `AskResponse` enum (`'allow' | 'always' | 'deny'`) — verify against current source before mapping.
- T6: The exact `createChildSession` factory shape SubagentScheduler expects — implementer reads `src/ui/terminalRepl.ts:931-955` to mirror.
- T8: MockProvider extension for agent-mode is optional; downgraded fallback documented.
- T9: Existing `packages/tui/internal/transport/` doesn't have an `api.go` for POST helpers; the implementer either creates one or inlines the POST in `app.go::postApproval` (the chosen pattern in the plan).

**Scope ceiling check:**
- 10 tasks; ~22 commits projected (one feat + one cleanup per non-trivial task, per M4 precedent); ~1 session at the M4 pace.
- Net new TS code ≈ 600 LoC (server + tests).
- Net new Go code ≈ 300 LoC (component + tests + handler edit).
- Doc changes ≈ 80 LoC (prereqs flip + ADRs + state snapshot).
- Total: comfortable under the M4 baseline.

**Self-review pass:** plan is implementable as written. Three pseudocode blocks remain (T5 readSseUntil, T8 dispatch test body, T10 integration scenarios) — each has a clear implementer-fillable instruction with a fallback. No type drift between tasks. Spec coverage complete.

---

## Execution

Use `superpowers:subagent-driven-development`:

- Fresh implementer subagent per task (T1–T10).
- After each implementer: spec compliance review subagent, then code quality review subagent (the standard two-stage pattern).
- Re-run the affected test slice + full server suite after each task.
- After T10: final whole-branch reviewer subagent before push.

Estimated effort: **~1 focused session**, ~25–30 subagent dispatches total (10 implementers + ~20 reviewers + cleanups; closely tracks M4's actuals).
