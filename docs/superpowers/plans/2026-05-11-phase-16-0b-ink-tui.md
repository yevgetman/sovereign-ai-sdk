# Phase 16.0b — Ink TUI + task event bus wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Ink-based foreground TUI that subscribes to the Phase 16.0a `DaemonEventBus`, drives the agent loop in-process inside the daemon, and replaces `sov chat` as the default interactive surface. Wire TaskManager to emit `task_update` events so the TUI can render live task cards.

**Architecture:** Single foreground process. The bare `sov` command (and `harness`) invokes `startInkTUI()` which: acquires the Phase 10.7 PID lock via `startDaemon()`, instantiates the daemon bus + session cache + approval queue, loads the bundle / config / providers / tools / skills / agents once, mounts an Ink `<App>` component as the foreground UI, and runs the agent loop per user turn. Stream events from `query()` push into a transcript reducer; bus events (`task_update`, `approval_requested`, etc.) push into the same store via separate slices. The TUI is the foreground subscriber; the bus already exists from 16.0a unchanged. The legacy raw-terminal `src/ui/terminalRepl.ts` is removed in this phase; the mission-wake non-interactive lifecycle moves to a dedicated `runMissionWake()` runner invoked by a new `sov mission run` subcommand.

**Tech Stack:** Ink 5 + React 18 (rendering), ink-testing-library (Ink-aware unit tests), existing `DaemonEventBus` / `SessionCache` / `ApprovalQueue` / `AgentRunner` / `COMMAND_REGISTRY` / `query()` generator / Phase 13.2 `TaskManager`. Bun's built-in test runner. Biome lint/format. TypeScript strict mode with `jsx: react-jsx`.

**Scope locked:**
- Build item 6 (Ink TUI scaffold + transcript + prompt + status line + task card)
- Build item 2 (TaskManager → bus task_update events)
- CLI surgery: remove `chat`, default bare `sov` to TUI, extract `sov mission run` for the non-interactive scheduled-mission wake path

**Out of scope (deferred):**
- Build item 5 (daemon-level compression threshold) — Phase 16.0c
- Approval queue interactive UI — Phase 16.0c / 16.7
- Slash command autocomplete — Phase 16.7 polish item per the build plan
- Tool-card rich rendering (diffs, syntax highlighting, etc.) — Phase 16.7
- `src/ui/configMenu.ts` Ink replacement — Phase 16.7

---

## File structure

```
package.json                                      # +deps: ink, react, ink-testing-library, @types/react
tsconfig.json                                     # +"jsx": "react-jsx"

src/ui/ink/                                       # NEW directory (Phase 16.0b)
  index.ts                                        # startInkTUI() — entry runner
  App.tsx                                         # Top-level component (mounts Transcript/Prompt/StatusLine)
  Transcript.tsx                                  # Streaming message list
  Prompt.tsx                                      # Input box with submit/abort
  StatusLine.tsx                                  # Bottom-of-screen status bar
  TaskCard.tsx                                    # Per-task live card
  state/
    types.ts                                      # UiState, UiEvent
    reducer.ts                                    # pure reducer (UiState, UiEvent) -> UiState
  hooks/
    useBusSubscription.ts                         # Subscribe to DaemonEventBus events into dispatch
    useAgentTurn.ts                               # Drive one agent turn given input

src/cli/missionRun.ts                             # NEW — extracted non-interactive mission wake
src/tasks/manager.ts                              # MODIFY — accept optional bus, emit task_update
src/main.ts                                       # MODIFY — remove `chat`, default to TUI, add `mission run`

src/ui/terminalRepl.ts                            # DELETE in Task 9
src/ui/configMenu.ts                              # KEEP (raw-mode picker — Phase 16.7 replaces it)
src/ui/inputEditor.ts                             # KEEP (still used by configMenu; deleted in 16.7)
src/ui/markdownStream.ts                          # KEEP (pure formatter — reusable by Ink)
[other src/ui/*.ts modules used only by terminalRepl] # DELETE in Task 9

tests/ui/ink/                                     # NEW
  App.test.tsx                                    # Full-render smoke test
  Transcript.test.tsx
  Prompt.test.tsx
  StatusLine.test.tsx
  state/reducer.test.ts                           # Pure reducer test (no Ink)
  hooks/useBusSubscription.test.tsx
tests/cli/missionRun.test.ts                      # NEW — non-interactive wake lifecycle
tests/tasks/manager.bus.test.ts                   # NEW — task_update emission
```

Total new files: ~14 source + ~8 test. Total deleted: 1 large file + ~5 raw-terminal helpers.

---

## Task 1: Add Ink + React deps and JSX config

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add deps via bun**

```bash
bun add ink@^5.0.1 react@^18.3.1
bun add -d @types/react@^18.3.0 ink-testing-library@^4.0.0
```

Expected: `bun.lockb` updates, `node_modules/ink` and `node_modules/react` present.

- [ ] **Step 2: Enable JSX in `tsconfig.json`**

Add `"jsx": "react-jsx"` to `compilerOptions`. Place it after `"esModuleInterop": true,` for visual proximity to the other interop settings.

After change, `compilerOptions` should include:
```json
"jsx": "react-jsx",
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `bun run typecheck`
Expected: exit 0. (No code uses JSX yet; this is just config in place.)

- [ ] **Step 4: Verify lint still passes**

Run: `bun run lint`
Expected: clean (or the 2 pre-existing warnings in `src/permissions/shellSemantics.ts` only).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb tsconfig.json
git commit -m "$(cat <<'EOF'
build(deps): add ink + react for Phase 16.0b TUI; enable jsx: react-jsx

- ink@5.0.1, react@18.3.1 — runtime
- @types/react, ink-testing-library — dev
- tsconfig.json: jsx: react-jsx (automatic runtime, no React import needed in .tsx files)
EOF
)"
```

---

## Task 2: TaskManager emits `task_update` to bus

**Files:**
- Modify: `src/tasks/manager.ts`
- Create: `tests/tasks/manager.bus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tasks/manager.bus.test.ts`:

```typescript
// Verifies Phase 16.0b build item 2: TaskManager pushes lifecycle
// transitions to the daemon event bus when one is supplied.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonEventBus } from '../../src/daemon/eventBus.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import type { SubagentScheduler } from '../../src/runtime/scheduler.js';
import { TaskManager } from '../../src/tasks/manager.js';
import type { CreateTaskInput } from '../../src/tasks/types.js';
import { TaskStore } from '../../src/tasks/store.js';

function fakeScheduler(): SubagentScheduler {
  return {
    delegate: async () => ({ reason: 'completed', resultPreview: 'ok' }),
  } as unknown as SubagentScheduler;
}

function makeStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tm-bus-'));
  const dbPath = join(dir, 'sessions.db');
  const store = new TaskStore(dbPath);
  return { store, cleanup: (): void => rmSync(dir, { recursive: true, force: true }) };
}

describe('TaskManager → bus', () => {
  it('emits task_update on queue and on terminal state', async () => {
    const { store, cleanup } = makeStore();
    try {
      const bus = new DaemonEventBus();
      const events: DaemonEvent[] = [];
      bus.on('task_update', (e) => events.push(e));

      const tm = new TaskManager({ store, scheduler: fakeScheduler(), bus });
      const input: CreateTaskInput = {
        sessionId: 'parent-sess',
        agentName: 'explore',
        prompt: 'test',
      };
      const created = await tm.create(input);

      // Allow async delegate() to resolve
      await new Promise((r) => setTimeout(r, 10));

      const updates = events.filter((e): e is Extract<DaemonEvent, { type: 'task_update' }> =>
        e.type === 'task_update' && e.taskId === created.id,
      );
      // Queue event + terminal event
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0]?.state).toBe('queued');
      expect(updates.at(-1)?.state).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('does not throw when no bus is supplied', async () => {
    const { store, cleanup } = makeStore();
    try {
      const tm = new TaskManager({ store, scheduler: fakeScheduler() });
      const created = await tm.create({ sessionId: 's', agentName: 'explore', prompt: 'p' });
      expect(created.id).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tasks/manager.bus.test.ts`
Expected: fails — `TaskManager` does not accept `bus` in opts and does not emit events.

- [ ] **Step 3: Read the current `TaskManager` source to find transition points**

Run: `bun run --silent cat src/tasks/manager.ts | head -100` (or just open the file). Identify:
- `TaskManagerOpts` type definition
- The `create()` method (initial 'queued' write)
- The terminal-state write inside the delegate() resolution (the two `state: finalState` lines around 161 and 172)

- [ ] **Step 4: Add bus to TaskManagerOpts and emit on transitions**

In `src/tasks/manager.ts`:

1. Import the bus type at the top:
   ```typescript
   import type { DaemonEventBus } from '../daemon/eventBus.js';
   ```
2. Extend `TaskManagerOpts`:
   ```typescript
   export type TaskManagerOpts = {
     store: TaskStore;
     scheduler: SubagentScheduler;
     bus?: DaemonEventBus;
   };
   ```
3. Store the bus on the manager (e.g. as `private readonly bus?: DaemonEventBus`) in the constructor.
4. After the initial `'queued'` insert in `create()`, emit:
   ```typescript
   this.bus?.emit({ type: 'task_update', taskId: id, state: 'queued' });
   ```
5. After each terminal write (success path and rejection path), emit:
   ```typescript
   this.bus?.emit({ type: 'task_update', taskId: id, state: finalState });
   ```
   Use the same `finalState` variable already present in scope.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/tasks/manager.bus.test.ts`
Expected: PASS — both cases (with bus, without bus).

- [ ] **Step 6: Run full unit suite to verify no regression**

Run: `bun test`
Expected: previous count (1805) + the 2 new tests = **1807/1807** passing.

- [ ] **Step 7: Typecheck + lint**

```bash
bun run typecheck
bun run lint
```
Both must exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/tasks/manager.ts tests/tasks/manager.bus.test.ts
git commit -m "$(cat <<'EOF'
feat(tasks): TaskManager emits task_update to daemon bus on lifecycle transitions

Phase 16.0b build item 2 — worker supervisor exposes task progress events
to the TUI via the existing DaemonEventBus. Bus argument is optional so
non-daemon callers (tests, future CLI tools) continue to work.

Emits 'queued' on create; emits the resolved TaskState (completed /
failed / cancelled / timed_out) when the scheduler resolves.
EOF
)"
```

---

## Task 3: Extract `runMissionWake()` from `terminalRepl.ts`

**Files:**
- Create: `src/cli/missionRun.ts`
- Create: `tests/cli/missionRun.test.ts`

The current `sov chat --agent scheduled-mission --state-dir <dir>` invocation does a single non-interactive wake. We will move that lifecycle out of the soon-to-be-deleted `terminalRepl.ts` and into a dedicated, headless runner. The new `sov mission run --state-dir <dir>` subcommand calls into it (added in Task 9).

- [ ] **Step 1: Locate the mission lifecycle code in `terminalRepl.ts`**

Run: `grep -n "stateDir\|supportsMissionState\|MISSION_TRANSITION\|loadMissionState" src/ui/terminalRepl.ts` and read those regions. Identify:
- Mission-mode early-exit gates (FSM terminal-state check)
- Auto-wake user message generation
- `MISSION_TRANSITION=<state>` sentinel parser
- `<mission-notes-update>` block parser
- Wake-log append + atomic state write-back
- Lock acquire/release (mkdir-based overlap guard)

These existing helpers in `src/mission/` (`state loader/atomic-writer/lock`, `FSM`, `prompt segments`) are the foundation; the lifecycle orchestration in `terminalRepl.ts` is what we're extracting.

- [ ] **Step 2: Write the failing test**

Create `tests/cli/missionRun.test.ts`:

```typescript
// Phase 16.0b — verifies runMissionWake() is callable headlessly given a
// pre-initialized mission directory and that it respects the overlap lock.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissionInit } from '../../src/cli/missionInit.js';
import { runMissionWake } from '../../src/cli/missionRun.js';

describe('runMissionWake', () => {
  it('exits early without error when the FSM is in a terminal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-'));
    try {
      // Use missionInit to scaffold a valid dir
      // (Replace with whichever init helper exists; the export name was
      // runMissionInit in src/cli/missionInit.ts. Adjust accordingly.)
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Force state to a terminal value
      const stateFile = join(dir, 'state.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.fsm = 'complete';
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

      const result = await runMissionWake({ stateDir: dir });
      expect(result.exitedEarly).toBe(true);
      expect(result.reason).toContain('terminal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns lockHeld result when a concurrent wake holds the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-lock-'));
    try {
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Create the lock directory manually to simulate an in-flight wake
      mkdirSync(join(dir, '.lock'));

      const result = await runMissionWake({ stateDir: dir });
      expect(result.lockHeld).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Note: if the init helper is named differently in `src/cli/missionInit.ts`, swap to whatever the implementer subagent finds — the contract (test passes) matters; the helper name is incidental.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/cli/missionRun.test.ts`
Expected: fails — `runMissionWake` not exported yet.

- [ ] **Step 4: Create `src/cli/missionRun.ts`**

Header comment:
```typescript
// Non-interactive scheduled-mission wake. Invoked by `sov mission run
// --state-dir <dir>` (and indirectly by launchd jobs). Performs exactly
// one wake: acquires the .lock/ overlap guard, loads state, runs a
// single agent turn against the scheduled-mission agent, parses the
// transition sentinel and notes-update block from the model's reply,
// writes the new state atomically, releases the lock. Headless — no
// TTY, no readline, no Ink.
```

Type signatures:
```typescript
export type MissionWakeOpts = {
  readonly stateDir: string;
  readonly bundlePath?: string;
};
export type MissionWakeResult = {
  readonly exitedEarly?: boolean;
  readonly lockHeld?: boolean;
  readonly reason?: string;
  readonly transitionedTo?: string;
};
export async function runMissionWake(opts: MissionWakeOpts): Promise<MissionWakeResult> { ... }
```

Implementation guidance (do NOT copy-paste the entire `terminalRepl.ts` mission block — port the logic cleanly):
1. Resolve `stateDir`, verify `mission.md` + `state.json` exist.
2. Try to acquire the `.lock/` directory via `mkdirSync(join(stateDir, '.lock'))`. If EEXIST, return `{ lockHeld: true, reason: 'lock held' }`.
3. Wrap the rest in `try` with `finally { rmSync(join(stateDir, '.lock'), {recursive: true, force: true}) }`.
4. Load the state via the existing `src/mission/` loader. If FSM state is terminal, return `{ exitedEarly: true, reason: 'mission in terminal state' }`.
5. Resolve bundle + provider via the existing helpers used by `terminalRepl.ts` (look for `resolveBundlePath` / agent definition loader). Set the active agent to `scheduled-mission`.
6. Compose the auto-wake user message from goal + plan + state + recent notes (existing `src/mission/` prompt-segments helper).
7. Call `query()` for exactly one turn. Iterate stream events without rendering — collect the final assistant text.
8. Parse `MISSION_TRANSITION=<state>` sentinel and `<mission-notes-update>` block from the assistant text.
9. Update FSM via existing FSM module; append wake-log entry; atomic-write state.
10. Return `{ transitionedTo: <state> }`.

The implementer should reuse as much from `src/mission/` and other harness modules as possible; new code should be limited to the orchestration glue. **No new logic** — just relocation.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/cli/missionRun.test.ts`
Expected: PASS — both cases.

- [ ] **Step 6: Run full unit suite**

Run: `bun test`
Expected: 1807 + 2 = **1809/1809**.

- [ ] **Step 7: Typecheck + lint**

Both must exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/cli/missionRun.ts tests/cli/missionRun.test.ts
git commit -m "$(cat <<'EOF'
refactor(mission): extract non-interactive wake into src/cli/missionRun.ts

Pulls the scheduled-mission lifecycle (lock guard, FSM gate, auto-wake
prompt composition, single-turn query, sentinel parsing, atomic state
write) out of the soon-to-be-deleted terminalRepl.ts. Future invocations
arrive via `sov mission run --state-dir <dir>` (wired in Task 9). No
behavior change — pure relocation.
EOF
)"
```

---

## Task 4: Ink TUI scaffold — entry, App, pure reducer

**Files:**
- Create: `src/ui/ink/index.ts`
- Create: `src/ui/ink/App.tsx`
- Create: `src/ui/ink/state/types.ts`
- Create: `src/ui/ink/state/reducer.ts`
- Create: `tests/ui/ink/state/reducer.test.ts`

The reducer is pure (no Ink, no async). It's the cleanest thing to TDD first.

- [ ] **Step 1: Write the failing reducer test**

Create `tests/ui/ink/state/reducer.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { initialUiState, reduce } from '../../../../src/ui/ink/state/reducer.js';
import type { UiEvent } from '../../../../src/ui/ink/state/types.js';

describe('ui reducer', () => {
  it('appends a user message on user_input_submitted', () => {
    const ev: UiEvent = { type: 'user_input_submitted', text: 'hi' };
    const next = reduce(initialUiState, ev);
    expect(next.transcript.length).toBe(1);
    expect(next.transcript[0]?.role).toBe('user');
    expect(next.transcript[0]?.text).toBe('hi');
  });

  it('appends to current assistant message on assistant_text_delta', () => {
    const seeded = reduce(initialUiState, { type: 'user_input_submitted', text: 'hi' });
    const a1 = reduce(seeded, { type: 'assistant_text_delta', delta: 'Hello' });
    const a2 = reduce(a1, { type: 'assistant_text_delta', delta: ' world' });
    const assistantMsg = a2.transcript.at(-1);
    expect(assistantMsg?.role).toBe('assistant');
    expect(assistantMsg?.text).toBe('Hello world');
  });

  it('marks status idle/thinking on agent_turn_start/end', () => {
    let s = reduce(initialUiState, { type: 'agent_turn_start' });
    expect(s.status).toBe('thinking');
    s = reduce(s, { type: 'agent_turn_end' });
    expect(s.status).toBe('idle');
  });

  it('upserts task cards from task_update events', () => {
    const s1 = reduce(initialUiState, {
      type: 'task_update',
      taskId: 't1',
      state: 'queued',
    });
    expect(s1.tasks['t1']?.state).toBe('queued');
    const s2 = reduce(s1, { type: 'task_update', taskId: 't1', state: 'completed' });
    expect(s2.tasks['t1']?.state).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/state/reducer.test.ts`
Expected: fails — modules don't exist.

- [ ] **Step 3: Create `src/ui/ink/state/types.ts`**

```typescript
// Phase 16.0b — Ink TUI state shape and event vocabulary.

export type UiStatus = 'idle' | 'thinking' | 'tool';

export type TranscriptMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; text: string; readonly streaming?: boolean }
  | { readonly role: 'system'; readonly text: string }
  | { readonly role: 'tool_use'; readonly toolName: string; readonly input: unknown }
  | { readonly role: 'tool_result'; readonly toolUseId: string; readonly content: string };

export type TaskCardState = {
  readonly taskId: string;
  readonly state: string;
};

export type UiState = {
  readonly transcript: ReadonlyArray<TranscriptMessage>;
  readonly status: UiStatus;
  readonly tasks: Readonly<Record<string, TaskCardState>>;
  readonly statusLine: Readonly<{
    cwd: string;
    profile: string;
    provider?: string;
    model?: string;
    sessionCostUsd?: number;
  }>;
};

export type UiEvent =
  | { type: 'user_input_submitted'; text: string }
  | { type: 'assistant_text_delta'; delta: string }
  | { type: 'assistant_message_complete' }
  | { type: 'tool_use'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'agent_turn_start' }
  | { type: 'agent_turn_end' }
  | { type: 'task_update'; taskId: string; state: string }
  | { type: 'status_line_update'; patch: Partial<UiState['statusLine']> }
  | { type: 'system_message'; text: string };
```

Note the mutability on assistant text: `text: string` (not readonly) — assistant deltas mutate the *last* assistant message's text accumulator. We allow this single mutation for streaming efficiency; React still re-renders because we return a new array each delta. Document this in a one-line comment above the assistant variant.

- [ ] **Step 4: Create `src/ui/ink/state/reducer.ts`**

```typescript
// Phase 16.0b — pure reducer for the Ink TUI. Every UiEvent maps to a
// new UiState; never mutate the previous state (except the streaming
// text accumulator on the assistant tail message, which is allowed for
// O(1) appends — see types.ts note).

import type { TranscriptMessage, UiEvent, UiState } from './types.js';

export const initialUiState: UiState = {
  transcript: [],
  status: 'idle',
  tasks: {},
  statusLine: { cwd: '', profile: 'default' },
};

export function reduce(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case 'user_input_submitted': {
      const msg: TranscriptMessage = { role: 'user', text: event.text };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'assistant_text_delta': {
      const last = state.transcript.at(-1);
      if (last?.role === 'assistant') {
        // Streaming append — mutate the text accumulator (see types.ts note),
        // but return a new array reference so React re-renders.
        const updated: TranscriptMessage = { ...last, text: last.text + event.delta };
        return { ...state, transcript: [...state.transcript.slice(0, -1), updated] };
      }
      const fresh: TranscriptMessage = { role: 'assistant', text: event.delta, streaming: true };
      return { ...state, transcript: [...state.transcript, fresh] };
    }
    case 'assistant_message_complete': {
      const last = state.transcript.at(-1);
      if (last?.role !== 'assistant') return state;
      const finalized: TranscriptMessage = { role: 'assistant', text: last.text };
      return { ...state, transcript: [...state.transcript.slice(0, -1), finalized] };
    }
    case 'tool_use': {
      const msg: TranscriptMessage = {
        role: 'tool_use',
        toolName: event.toolName,
        input: event.input,
      };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'tool_result': {
      const msg: TranscriptMessage = {
        role: 'tool_result',
        toolUseId: event.toolUseId,
        content: event.content,
      };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'agent_turn_start':
      return { ...state, status: 'thinking' };
    case 'agent_turn_end':
      return { ...state, status: 'idle' };
    case 'task_update':
      return {
        ...state,
        tasks: { ...state.tasks, [event.taskId]: { taskId: event.taskId, state: event.state } },
      };
    case 'status_line_update':
      return { ...state, statusLine: { ...state.statusLine, ...event.patch } };
    case 'system_message':
      return {
        ...state,
        transcript: [...state.transcript, { role: 'system', text: event.text }],
      };
  }
}
```

- [ ] **Step 5: Run reducer test to verify it passes**

Run: `bun test tests/ui/ink/state/reducer.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 6: Create the App scaffold and entry runner**

`src/ui/ink/App.tsx`:

```tsx
// Phase 16.0b — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. The dispatch is
// fed by:
//   - user input from <Prompt>
//   - stream events from query() (driven by useAgentTurn in Task 8)
//   - bus events from the DaemonEventBus (subscribed in Task 8)

import { Box, Text } from 'ink';
import { useReducer } from 'react';
import { initialUiState, reduce } from './state/reducer.js';

type AppProps = {
  readonly cwd: string;
  readonly profile: string;
};

export function App({ cwd, profile }: AppProps): JSX.Element {
  const [state] = useReducer(reduce, {
    ...initialUiState,
    statusLine: { cwd, profile },
  });
  return (
    <Box flexDirection="column">
      <Box flexGrow={1}>
        <Text dimColor>Phase 16.0b TUI scaffold — transcript will mount here.</Text>
      </Box>
      <Box>
        <Text dimColor>
          {state.statusLine.profile} · {state.statusLine.cwd}
        </Text>
      </Box>
    </Box>
  );
}
```

`src/ui/ink/index.ts`:

```typescript
// Phase 16.0b — Ink TUI entry. startInkTUI() acquires the daemon lock,
// instantiates the bus + caches, mounts <App>, and waits for exit.

import { render } from 'ink';
import { resolveHarnessHome } from '../../config/paths.js';
import { startDaemon } from '../../daemon/runner.js';
import { App } from './App.js';

export type StartInkTUIOpts = {
  readonly bundlePath?: string;
};

export async function startInkTUI(opts: StartInkTUIOpts = {}): Promise<number> {
  const home = resolveHarnessHome();
  const daemon = startDaemon({ harnessHome: home });
  const instance = render(<App cwd={process.cwd()} profile={home} />);
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    daemon.shutdown();
  }
}
```

(Note the `opts.bundlePath` parameter is accepted for forward-compatibility with later tasks; not yet used.)

- [ ] **Step 7: Smoke-test the scaffold compiles**

Run: `bun run typecheck`
Expected: exit 0.

If TypeScript complains about `JSX.Element` being unresolved, ensure `@types/react` is installed and `"jsx": "react-jsx"` is set (Task 1).

- [ ] **Step 8: Commit**

```bash
git add src/ui/ink tests/ui/ink/state
git commit -m "$(cat <<'EOF'
feat(ui): Ink TUI scaffold — App + pure UiState reducer

Phase 16.0b build item 6 (part 1) — entry runner that mounts an Ink
<App>, a pure reducer over UiState/UiEvent that handles user input,
assistant streaming, tool use/result, task updates, and status line
patches. Reducer is fully unit-tested; App is the smallest viable scaffold
the next tasks build on.
EOF
)"
```

---

## Task 5: Transcript component

**Files:**
- Create: `src/ui/ink/Transcript.tsx`
- Create: `tests/ui/ink/Transcript.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/ink/Transcript.test.tsx`:

```tsx
import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Transcript } from '../../../src/ui/ink/Transcript.js';
import type { TranscriptMessage } from '../../../src/ui/ink/state/types.js';

describe('Transcript', () => {
  it('renders user, assistant, and tool messages in order', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', text: 'list src/' },
      { role: 'tool_use', toolName: 'Bash', input: { command: 'ls src/' } },
      { role: 'tool_result', toolUseId: 'tu_1', content: 'foo.ts bar.ts' },
      { role: 'assistant', text: 'You have two files: foo.ts, bar.ts.' },
    ];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('list src/');
    expect(out).toContain('Bash');
    expect(out).toContain('foo.ts');
    expect(out).toContain('two files');
  });

  it('renders empty state cleanly', () => {
    const { lastFrame } = render(<Transcript messages={[]} />);
    expect(lastFrame()).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/Transcript.test.tsx`
Expected: fails — Transcript not exported.

- [ ] **Step 3: Create `src/ui/ink/Transcript.tsx`**

```tsx
// Phase 16.0b — Transcript renderer. One <Box> per message, color-coded by
// role. Tool input is JSON-stringified for now; rich rendering deferred
// to Phase 16.7.

import { Box, Text } from 'ink';
import type { TranscriptMessage } from './state/types.js';

type TranscriptProps = {
  readonly messages: ReadonlyArray<TranscriptMessage>;
};

export function Transcript({ messages }: TranscriptProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageRow key={i} msg={msg} />
      ))}
    </Box>
  );
}

function MessageRow({ msg }: { readonly msg: TranscriptMessage }): JSX.Element {
  switch (msg.role) {
    case 'user':
      return (
        <Box>
          <Text color="cyan">{'> '}</Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor italic>
            {msg.text}
          </Text>
        </Box>
      );
    case 'tool_use':
      return (
        <Box>
          <Text color="yellow">⚙ {msg.toolName}</Text>
          <Text dimColor> {summarizeToolInput(msg.input)}</Text>
        </Box>
      );
    case 'tool_result':
      return (
        <Box>
          <Text color="green">↪ </Text>
          <Text dimColor>{truncate(msg.content, 200)}</Text>
        </Box>
      );
  }
}

function summarizeToolInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return truncate(s, 100);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/ink/Transcript.test.tsx`
Expected: 2/2 PASS.

- [ ] **Step 5: Wire Transcript into App**

In `src/ui/ink/App.tsx`, replace the placeholder `<Text dimColor>Phase 16.0b TUI scaffold ...</Text>` with `<Transcript messages={state.transcript} />`. Import Transcript from `./Transcript.js`.

- [ ] **Step 6: Typecheck + lint**

```bash
bun run typecheck
bun run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/ink/Transcript.tsx src/ui/ink/App.tsx tests/ui/ink/Transcript.test.tsx
git commit -m "feat(ui): Transcript component renders messages by role"
```

---

## Task 6: Prompt input component

**Files:**
- Create: `src/ui/ink/Prompt.tsx`
- Create: `tests/ui/ink/Prompt.test.tsx`

Ink ships a `useInput` hook for keypress handling. We'll build a minimal prompt: typing accumulates into `value`, Enter submits, Ctrl-C requests abort, Backspace deletes. No multi-line, no autocomplete (Phase 16.7).

- [ ] **Step 1: Write the failing test**

Create `tests/ui/ink/Prompt.test.tsx`:

```tsx
import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Prompt } from '../../../src/ui/ink/Prompt.js';

describe('Prompt', () => {
  it('echoes typed characters into the input buffer', () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} onAbort={() => {}} />);
    stdin.write('hello');
    expect(lastFrame() ?? '').toContain('hello');
  });

  it('calls onSubmit with the buffered text on Enter and clears the buffer', () => {
    let submitted = '';
    const { stdin, lastFrame } = render(
      <Prompt onSubmit={(t) => { submitted = t; }} onAbort={() => {}} />,
    );
    stdin.write('hi there');
    stdin.write('\r'); // Enter
    expect(submitted).toBe('hi there');
    expect(lastFrame() ?? '').not.toContain('hi there');
  });

  it('calls onAbort when Ctrl-C is pressed', () => {
    let aborted = false;
    const { stdin } = render(
      <Prompt onSubmit={() => {}} onAbort={() => { aborted = true; }} />,
    );
    stdin.write('\x03'); // Ctrl-C
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/Prompt.test.tsx`
Expected: fails — Prompt not exported.

- [ ] **Step 3: Create `src/ui/ink/Prompt.tsx`**

```tsx
// Phase 16.0b — minimal prompt input. Accumulates characters into a
// buffer; Enter submits + clears; Ctrl-C signals abort; Backspace
// deletes the previous character. No autocomplete (Phase 16.7).

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

type PromptProps = {
  readonly onSubmit: (text: string) => void;
  readonly onAbort: () => void;
};

export function Prompt({ onSubmit, onAbort }: PromptProps): JSX.Element {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length > 0) onSubmit(trimmed);
      setValue('');
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.meta && !key.ctrl) {
      setValue((v) => v + input);
    }
  });
  return (
    <Box>
      <Text color="cyan">{'❯ '}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/ink/Prompt.test.tsx`
Expected: 3/3 PASS. (If `\r` doesn't trigger `key.return` in ink-testing-library, try `\n` instead — adjust the test rather than the component.)

- [ ] **Step 5: Wire Prompt into App**

In `src/ui/ink/App.tsx`:
- Convert `useReducer` to expose `dispatch`: `const [state, dispatch] = useReducer(...)`.
- Add `<Prompt onSubmit={(text) => dispatch({ type: 'user_input_submitted', text })} onAbort={() => process.exit(0)} />` below the Transcript.

- [ ] **Step 6: Typecheck + lint**

- [ ] **Step 7: Commit**

```bash
git add src/ui/ink/Prompt.tsx src/ui/ink/App.tsx tests/ui/ink/Prompt.test.tsx
git commit -m "feat(ui): Prompt input — Enter submits, Ctrl-C aborts, Backspace edits"
```

---

## Task 7: Status line component

**Files:**
- Create: `src/ui/ink/StatusLine.tsx`
- Create: `tests/ui/ink/StatusLine.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/ink/StatusLine.test.tsx`:

```tsx
import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { StatusLine } from '../../../src/ui/ink/StatusLine.js';

describe('StatusLine', () => {
  it('renders cwd, profile, provider, model, and cost', () => {
    const { lastFrame } = render(
      <StatusLine
        statusLine={{
          cwd: '/Users/julie/code/sovereign-ai-harness',
          profile: 'default',
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          sessionCostUsd: 0.42,
        }}
        status="idle"
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('default');
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('$0.42');
  });

  it('shows a "thinking" indicator when status is thinking', () => {
    const { lastFrame } = render(
      <StatusLine
        statusLine={{ cwd: '.', profile: 'default' }}
        status="thinking"
      />,
    );
    expect(lastFrame() ?? '').toMatch(/thinking|⠋|·|·/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/StatusLine.test.tsx`

- [ ] **Step 3: Create `src/ui/ink/StatusLine.tsx`**

```tsx
// Phase 16.0b — bottom status line. Shows profile, cwd (basename),
// provider · model, session cost, and a thinking indicator. Phase 16.7
// will add a cache-hit rate, route info, and richer per-tool state.

import { Box, Text } from 'ink';
import { basename } from 'node:path';
import type { UiState, UiStatus } from './state/types.js';

type StatusLineProps = {
  readonly statusLine: UiState['statusLine'];
  readonly status: UiStatus;
};

export function StatusLine({ statusLine, status }: StatusLineProps): JSX.Element {
  const parts: string[] = [];
  parts.push(statusLine.profile);
  parts.push(basename(statusLine.cwd) || '.');
  if (statusLine.provider !== undefined && statusLine.model !== undefined) {
    parts.push(`${statusLine.provider} · ${statusLine.model}`);
  }
  if (statusLine.sessionCostUsd !== undefined) {
    parts.push(`$${statusLine.sessionCostUsd.toFixed(2)}`);
  }
  if (status === 'thinking') parts.push('thinking…');
  if (status === 'tool') parts.push('tool…');
  return (
    <Box>
      <Text dimColor>{parts.join(' · ')}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/ink/StatusLine.test.tsx`
Expected: 2/2 PASS.

- [ ] **Step 5: Wire StatusLine into App**

In `src/ui/ink/App.tsx`, replace the temporary inline `<Box><Text dimColor>{state.statusLine.profile} · {state.statusLine.cwd}</Text></Box>` with `<StatusLine statusLine={state.statusLine} status={state.status} />`.

- [ ] **Step 6: Typecheck + lint**

- [ ] **Step 7: Commit**

```bash
git add src/ui/ink/StatusLine.tsx src/ui/ink/App.tsx tests/ui/ink/StatusLine.test.tsx
git commit -m "feat(ui): StatusLine component — profile, cwd, provider, model, cost, thinking indicator"
```

---

## Task 8: Wire the agent loop + bus subscription into the TUI

**Files:**
- Create: `src/ui/ink/hooks/useBusSubscription.ts`
- Create: `src/ui/ink/hooks/useAgentTurn.ts`
- Modify: `src/ui/ink/App.tsx`
- Modify: `src/ui/ink/index.ts`
- Create: `tests/ui/ink/hooks/useBusSubscription.test.tsx`

This is the biggest task: connect Ink dispatch to two upstreams — the daemon bus (for `task_update` and lifecycle events) and the agent stream (for assistant deltas, tool use/result, turn boundaries).

- [ ] **Step 1: Write the failing bus subscription test**

Create `tests/ui/ink/hooks/useBusSubscription.test.tsx`:

```tsx
import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useReducer } from 'react';
import { DaemonEventBus } from '../../../../src/daemon/eventBus.js';
import { useBusSubscription } from '../../../../src/ui/ink/hooks/useBusSubscription.js';
import { initialUiState, reduce } from '../../../../src/ui/ink/state/reducer.js';

function Harness({ bus }: { bus: DaemonEventBus }): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialUiState);
  useBusSubscription(bus, dispatch);
  const taskCount = Object.keys(state.tasks).length;
  return <Text>tasks={taskCount}</Text>;
}

describe('useBusSubscription', () => {
  it('dispatches task_update bus events into the reducer', async () => {
    const bus = new DaemonEventBus();
    const { lastFrame, rerender } = render(<Harness bus={bus} />);
    expect(lastFrame()).toContain('tasks=0');
    bus.emit({ type: 'task_update', taskId: 't1', state: 'queued' });
    rerender(<Harness bus={bus} />);
    // Allow microtask
    await new Promise((r) => setImmediate(r));
    expect(lastFrame()).toContain('tasks=1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/hooks/useBusSubscription.test.tsx`
Expected: fails — hook not exported.

- [ ] **Step 3: Create `src/ui/ink/hooks/useBusSubscription.ts`**

```typescript
// Phase 16.0b — subscribes the TUI dispatch to DaemonEventBus events.
// Currently maps:
//   - task_update      -> reducer task_update
//   - daemon_stopping  -> reducer system_message
// Other bus events are accepted for forward-compatibility but not
// rendered yet (approval UI is Phase 16.0c).

import { useEffect } from 'react';
import type { DaemonEventBus } from '../../../daemon/eventBus.js';
import type { UiEvent } from '../state/types.js';

export function useBusSubscription(
  bus: DaemonEventBus,
  dispatch: (event: UiEvent) => void,
): void {
  useEffect(() => {
    const taskHandler = (e: { taskId: string; state: string }): void => {
      dispatch({ type: 'task_update', taskId: e.taskId, state: e.state });
    };
    const stopHandler = (e: { reason: string }): void => {
      dispatch({ type: 'system_message', text: `daemon stopping (${e.reason})` });
    };
    bus.on('task_update', taskHandler);
    bus.on('daemon_stopping', stopHandler);
    return (): void => {
      bus.off('task_update', taskHandler);
      bus.off('daemon_stopping', stopHandler);
    };
  }, [bus, dispatch]);
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `bun test tests/ui/ink/hooks/useBusSubscription.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create `src/ui/ink/hooks/useAgentTurn.ts`**

This is the heart of the integration. It accepts a `submit(text)` callback that the App will invoke when the user hits Enter; the hook drives one turn against the AgentRunner / `query()` generator and pushes stream events into dispatch.

```typescript
// Phase 16.0b — drives one user turn against the harness agent loop.
// Iterates query()'s AsyncGenerator and translates Stream/Message events
// into UiEvents for the Ink TUI reducer. Status transitions to
// 'thinking' on turn start and back to 'idle' on turn end.

import { useCallback } from 'react';
import type { AgentRunner } from '../../../core/runner.js';   // adjust path if different
import type { UiEvent } from '../state/types.js';

type Submit = (text: string) => Promise<void>;

export function useAgentTurn(
  runner: AgentRunner,
  dispatch: (event: UiEvent) => void,
): { submit: Submit } {
  const submit = useCallback<Submit>(
    async (text) => {
      dispatch({ type: 'user_input_submitted', text });
      dispatch({ type: 'agent_turn_start' });
      try {
        for await (const event of runner.send(text)) {
          // The exact event shape mirrors what terminalRepl.ts already
          // consumes — implementer should look at terminalRepl.ts's
          // for-await over the same generator for the mapping.
          if (event.type === 'assistant_text_delta') {
            dispatch({ type: 'assistant_text_delta', delta: event.delta });
          } else if (event.type === 'assistant_message_complete') {
            dispatch({ type: 'assistant_message_complete' });
          } else if (event.type === 'tool_use') {
            dispatch({ type: 'tool_use', toolName: event.name, input: event.input });
          } else if (event.type === 'tool_result') {
            dispatch({ type: 'tool_result', toolUseId: event.toolUseId, content: event.content });
          }
          // Other events (thinking deltas, etc.) — ignore for now; Phase 16.7.
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      } finally {
        dispatch({ type: 'agent_turn_end' });
      }
    },
    [runner, dispatch],
  );
  return { submit };
}
```

**Important:** The exact `AgentRunner` interface (`runner.send(text)`, event shapes) must be confirmed by the implementer against the current `src/core/runner.ts` and `src/core/query.ts`. The shapes above are likely-but-not-exact placeholders. The implementer should:
1. Open `src/core/query.ts` and `src/ui/terminalRepl.ts` to see how the for-await loop consumes stream events today.
2. Mirror that mapping into `useAgentTurn.ts`.
3. Adjust `UiEvent` (in `state/types.ts`) if a needed event shape was missed.

- [ ] **Step 6: Wire hooks into App**

Refactor `src/ui/ink/App.tsx` to accept the runner + bus:

```tsx
import { Box } from 'ink';
import { useReducer } from 'react';
import type { AgentRunner } from '../../core/runner.js';
import type { DaemonEventBus } from '../../daemon/eventBus.js';
import { Prompt } from './Prompt.js';
import { StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import { useAgentTurn } from './hooks/useAgentTurn.js';
import { useBusSubscription } from './hooks/useBusSubscription.js';
import { initialUiState, reduce } from './state/reducer.js';

type AppProps = {
  readonly runner: AgentRunner;
  readonly bus: DaemonEventBus;
  readonly cwd: string;
  readonly profile: string;
  readonly provider?: string;
  readonly model?: string;
};

export function App({ runner, bus, cwd, profile, provider, model }: AppProps): JSX.Element {
  const [state, dispatch] = useReducer(reduce, {
    ...initialUiState,
    statusLine: { cwd, profile, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
  });
  useBusSubscription(bus, dispatch);
  const { submit } = useAgentTurn(runner, dispatch);
  return (
    <Box flexDirection="column">
      <Box flexGrow={1} flexDirection="column">
        <Transcript messages={state.transcript} />
      </Box>
      <Prompt onSubmit={(text) => { void submit(text); }} onAbort={() => process.exit(0)} />
      <StatusLine statusLine={state.statusLine} status={state.status} />
    </Box>
  );
}
```

- [ ] **Step 7: Wire the runner into `startInkTUI`**

Update `src/ui/ink/index.ts` to construct an AgentRunner (mirroring how `terminalRepl.ts` does it today — bundle load + provider resolution + session DB + agent runner construction) and pass it + the daemon bus into `<App>`.

The implementer should look at `src/ui/terminalRepl.ts`'s `runRepl()` setup phase (everything from "load bundle" through "construct AgentRunner") and lift that prologue, with these substitutions:
- Drop all readline/raw-mode code.
- Pass `bus: daemon.bus` into the `TaskManager` constructor (Task 2 added the parameter).
- Pass `runner` and `daemon.bus` into `<App>`.

Wrap the `render(<App ... />)` call exactly as in Task 4's scaffold, but with the real props.

- [ ] **Step 8: Run the full unit suite**

Run: `bun test`
Expected: previous (1809) + new hook test (1) = **1810/1810** at minimum; the Transcript / Prompt / StatusLine tests landed in earlier tasks already counted.

- [ ] **Step 9: Smoke-test in a real terminal**

```bash
bun src/main.ts daemon &    # current sov daemon still works
DAEMON_PID=$!
# In another terminal:
HARNESS_HOME=/tmp/test-harness bun -e "import { startInkTUI } from './src/ui/ink/index.js'; await startInkTUI();"
# Verify: TUI mounts, prompt accepts input, hitting Enter sends a turn,
# assistant text streams in, tool uses appear, status line updates.
kill $DAEMON_PID
```

(Note: the smoke test invokes `startInkTUI` directly; the bare `sov` wiring is Task 9.)

- [ ] **Step 10: Typecheck + lint**

- [ ] **Step 11: Commit**

```bash
git add src/ui/ink tests/ui/ink/hooks
git commit -m "$(cat <<'EOF'
feat(ui): wire Ink TUI to agent loop + daemon bus

Phase 16.0b build item 6 (final) — useAgentTurn drives one query() turn
per user submit, translating stream events into UiEvents; useBusSubscription
forwards task_update + daemon_stopping events into the same reducer.
startInkTUI constructs the AgentRunner the same way terminalRepl did and
mounts <App runner bus />.

TaskManager (Task 2) gets daemon.bus passed in so task_create from inside
the agent loop produces live task cards in the TUI.
EOF
)"
```

---

## Task 9: CLI rewiring — bare `sov` opens TUI, remove `chat`, add `mission run`

**Files:**
- Modify: `src/main.ts`
- Delete: `src/ui/terminalRepl.ts`
- Delete: other `src/ui/*.ts` modules used only by `terminalRepl`
- Update: any imports broken by the deletions

This is structural surgery. Be careful — many things depend on `terminalRepl.ts`.

- [ ] **Step 1: Inventory what depends on `terminalRepl.ts`**

```bash
grep -rln "terminalRepl\|runRepl" src tests --include="*.ts" --include="*.tsx"
```

Likely hits: `src/main.ts` (the chat command), possibly some tests. Note them.

- [ ] **Step 2: Inventory which `src/ui/*.ts` modules are imported ONLY by `terminalRepl.ts`**

```bash
for f in src/ui/*.ts; do
  base=$(basename "$f" .ts)
  if [ "$base" = "terminalRepl" ] || [ "$base" = "configMenu" ] || [ "$base" = "inputEditor" ] || [ "$base" = "markdownStream" ]; then
    continue
  fi
  importers=$(grep -rln "from '\\.\\./ui/$base\\.js'\\|from './$base\\.js'" src tests | grep -v "^src/ui/$base\\.ts\$" || true)
  echo "=== $f ==="
  echo "$importers"
done
```

Files with **zero** non-`terminalRepl` importers are deletable. Files with importers outside `terminalRepl` stay. Likely safe to delete: `autocomplete.ts`, `box.ts`, `bracketedPaste.ts`, `contextMeter.ts`, `footer.ts`, `inlineShell.ts`, `keypress.ts`, `picker.ts`, `queuedQuestion.ts`, `sessionSummary.ts`, `splash.ts`, `terminalMessages.ts`, `textBuffer.ts`, `theme.ts`, `thinking.ts`, `toolFooter.ts`, `toolSlot.ts`, `transcript.ts`, `inputHistory.ts`, `modal.ts`, `diff.ts`. **Probable keepers (used elsewhere):** `configMenu.ts` (still used by `sov config`), `inputEditor.ts` (used by `configMenu`), `markdownStream.ts` (pure formatter — keep, may reuse from Ink later).

Document the exact list **after running the grep**, before deleting. Do NOT delete files that have non-terminalRepl importers.

- [ ] **Step 3: Modify `src/main.ts`**

Three changes:

**(a) Remove the entire `chat` command block** (currently at `src/main.ts:160-219` per `git grep -n "command('chat'"`). Delete from `program.command('chat', { isDefault: true })` through the closing `});`.

**(b) Add a default action on `program` itself, calling the TUI:**

Place near the top of `runHarness()` (before `program.parseAsync`):

```typescript
program
  .description('Sovereign AI harness — interactive TUI by default; subcommands for ops')
  .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
  .option('--provider <name>', 'provider name: anthropic, openai, ollama, or openrouter')
  .option('-m, --model <name>', 'model name (overrides provider/config default)')
  .option('--resume <id>', 'resume a prior session by its UUID')
  .option('--no-cache', 'disable provider prompt-cache markers for this session')
  .action(async (opts) => {
    const { startInkTUI } = await import('./ui/ink/index.js');
    const exitCode = await startInkTUI({
      ...(opts.bundle !== undefined ? { bundlePath: resolveBundlePath(opts.bundle) ?? undefined } : {}),
      ...(opts.provider !== undefined ? { providerName: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.resume !== undefined ? { resumeId: opts.resume } : {}),
      ...(opts.cache === false ? { noCache: true } : {}),
    });
    process.exit(exitCode);
  });
```

(The exact subset of options to surface on the default action should be conservative — only what `chat` actually wired in. The implementer should pull the matching subset from the removed `chat` block.)

Also update `startInkTUI`'s `StartInkTUIOpts` type to accept these knobs (forwarding them into the AgentRunner construction inside `startInkTUI`).

**(c) Add the `sov mission run` subcommand**, alongside `sov mission init`:

```typescript
missionCmd
  .command('run')
  .description('Execute one non-interactive scheduled-mission wake against a mission directory')
  .requiredOption('--state-dir <path>', 'path to the mission directory')
  .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
  .action(async (opts) => {
    const { runMissionWake } = await import('./cli/missionRun.js');
    const result = await runMissionWake({
      stateDir: opts.stateDir,
      ...(opts.bundle !== undefined ? { bundlePath: opts.bundle } : {}),
    });
    if (result.lockHeld === true) {
      process.stderr.write('lock held — another wake in progress\n');
      process.exit(0);
    }
    if (result.exitedEarly === true) {
      process.stderr.write(`exited early: ${result.reason ?? 'unknown'}\n`);
      process.exit(0);
    }
    process.stdout.write(`transitioned to: ${result.transitionedTo ?? '<unchanged>'}\n`);
    process.exit(0);
  });
```

- [ ] **Step 4: Delete `terminalRepl.ts` and the helper UI files identified in Step 2**

After confirming the importer graph in Step 2:

```bash
git rm src/ui/terminalRepl.ts
git rm src/ui/<file>.ts   # for each safe-to-delete file
```

- [ ] **Step 5: Run typecheck — fix any broken imports**

```bash
bun run typecheck
```

Fix any errors — they'll all be from files that still imported deleted modules. Either replace the import with an Ink-side equivalent or remove the dead code path.

- [ ] **Step 6: Run lint**

```bash
bun run lint
```

Fix any new lint errors.

- [ ] **Step 7: Run full unit suite**

```bash
bun test
```

Expected: roughly **1810/1810** (the new tests from Tasks 2/3/4/5/6/7/8 minus any tests that exercised terminalRepl directly and were deleted with it).

If tests previously asserted against terminalRepl's behavior, update them to assert against Ink components or delete them if redundant.

- [ ] **Step 8: Smoke-test the rewiring**

```bash
# Bare sov should open the TUI:
bun src/main.ts
# (Ctrl-C to exit)

# Mission run should still work:
mkdir -p /tmp/test-mission
bun src/main.ts mission init /tmp/test-mission --goal "test"
bun src/main.ts mission run --state-dir /tmp/test-mission

# sov chat should NOT exist:
bun src/main.ts chat  # expect error: "unknown command 'chat'"

# Daemon command still works:
bun src/main.ts daemon
# (kill with Ctrl-C)
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(cli): bare 'sov' opens Ink TUI; remove 'chat' command; add 'sov mission run'

Phase 16.0b — terminal entry rewiring:

- Bare 'sov' (and 'harness') now opens the new Ink TUI by default,
  hosted inside the daemon (single foreground process; daemon bus +
  agent loop + Ink rendering in-process).
- 'sov chat' is removed. The previous '--agent <name> --state-dir <path>'
  flags on chat (scheduled-mission wake path) move to a dedicated
  non-interactive 'sov mission run --state-dir <path>' subcommand,
  invoking the runMissionWake() runner extracted in Task 3.
- Deletes src/ui/terminalRepl.ts and helper UI modules used only by it;
  configMenu, inputEditor (still used by 'sov config'), and markdownStream
  (pure formatter, candidate for Ink reuse) are retained.

OPS REPO FOLLOW-UP (out of scope for this commit):
- ~/code/sovereign-ai-ops/mission/install.sh references
  'harness chat --agent scheduled-mission --state-dir <dir>'. The launchd
  job template should be updated to 'harness mission run --state-dir <dir>'.
EOF
)"
```

---

## Task 10: Docs cascade + sov upgrade

**Files:**
- Modify: `docs/state-of-build-2026-05-11.md` (or create dated successor)
- Modify: `CLAUDE.md`
- Modify: `docs/semantic-testing.md`
- Modify: `docs/testing-log-2026-04-27.md`
- Sister-repo cascade: `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` (Phase 16.0 status update), `~/code/sovereign-ai-docs/harness/docs/runtime/phase-10x-status.md`, `~/code/sovereign-ai-docs/state/status/dev.md`, `~/code/sovereign-ai-docs/state/CONTEXT.md`, `~/code/sovereign-ai-docs/state/feed/CHANGELOG.md`

- [ ] **Step 1: Update `docs/state-of-build-2026-05-11.md`** (or create `docs/state-of-build-<today>.md` if you ran into the next calendar day)

Add a Phase 16.0b section with the commit table; update HEAD, unit suite count, "where to start", and test-gate baseline.

- [ ] **Step 2: Update `CLAUDE.md`**

Add a Phase 16.0b paragraph. Pattern: "Phase 16.0b (Ink TUI + task event bus) shipped <date> — `src/ui/ink/` (App, Transcript, Prompt, StatusLine, hooks, reducer); `TaskManager` emits `task_update` to the daemon bus; bare `sov` and `harness` open the TUI; `sov chat` removed; `sov mission run --state-dir <dir>` replaces the non-interactive mission wake path; `src/ui/terminalRepl.ts` and helper modules deleted. Unit suite: <N>/<N>." Update "next high-leverage targets" to Phase 16.0c (compression threshold) and Phase 16.5 (Telegram).

- [ ] **Step 3: Update `docs/semantic-testing.md`**

Audit: Phase 16.0b adds **no new agent-facing tools, slash commands, permission rule paths, or context surfaces** (Ink is a presentation layer; existing commands keep working via the registry). Document the audit decision: "Phase 16.0b — Ink TUI + task events — 0 tests (audited, none required — no new agent-facing surface; existing slash commands and tools route through the same registry/permission system)."

- [ ] **Step 4: Append a testing-log entry**

In `docs/testing-log-2026-04-27.md`, prepend an entry for Phase 16.0b: scope (TUI scaffold + task events + CLI rewiring), commands run (typecheck, lint, full unit suite, smoke test), manual coverage (bare `sov` opens TUI; mission run works; chat removed; daemon still starts), result (pass), follow-ups (ops repo install.sh update).

- [ ] **Step 5: Cascade sovereign-ai-docs**

```bash
cd /Users/julie/code/sovereign-ai-docs

# Edit harness/docs/runtime/harness-build-plan.md:
#   - Bump version (9 → 10, supersedes 8 → 9)
#   - Update Phase 16.0 status snapshot: 16.0b shipped, remaining items 5
#   - Add a vN delta entry
#   - In Phase 16.0 section, append "Phase 16.0b landed (<date>): items 2, 6
#     complete; item 5 (compression threshold) deferred to 16.0c."

# Edit harness/docs/runtime/phase-10x-status.md:
#   - Bump version, update depends_on pin, update unit headline.

# Edit state/status/dev.md:
#   - Update depends_on pin to harness-build-plan@<new>
#   - Now / Recent sections.

# Edit state/CONTEXT.md:
#   - Two paragraphs updated for Phase 16.0b and new unit count.

# Prepend an entry to state/feed/CHANGELOG.md.

# Commit and push (the pre-commit cascade hook will auto-bump dependent
# doc pins; let it run, fix anything it surfaces, then re-add + commit).
git add -A
git commit -m "docs(status): cascade Phase 16.0b — Ink TUI shipped; harness-build-plan@<new>"
git push origin master
```

- [ ] **Step 6: Run `sov upgrade`**

```bash
sov upgrade
```

Required by CLAUDE.md after any runtime-affecting change. Phase 16.0b touches `src/` heavily — upgrade is mandatory so the global `sov` binary picks up master.

- [ ] **Step 7: Final test-gate run**

```bash
bun run typecheck
bun run lint
bun test
bun run test:semantic
```

All four must pass. Semantic suite (58/58) should be unchanged — no new agent-facing surfaces.

- [ ] **Step 8: Commit harness-repo docs**

```bash
cd /Users/julie/code/sovereign-ai-harness
git add docs/state-of-build-*.md CLAUDE.md docs/semantic-testing.md docs/testing-log-*.md
git commit -m "docs: reconcile Phase 16.0b shipped — Ink TUI, task events, CLI rewiring"
git push origin master
```

---

## Self-review checklist

After completing all 10 tasks, run through this checklist before declaring the phase shipped:

1. **Bare `sov`** opens the Ink TUI in a real terminal (not just in tests).
2. **`sov chat`** prints "unknown command".
3. **`sov mission run --state-dir <dir>`** runs one wake on a scaffolded mission and exits cleanly.
4. **`sov daemon`** still starts headlessly with the bus-only behavior; PID lock still works (start a second one → "already running").
5. **`harness --help | grep state-dir`** still finds something — required by `~/code/sovereign-ai-ops/mission/install.sh`. After the rewiring, this lives under `harness mission run --help`. If the ops install.sh greps top-level help, it will fail; flag this in the ops-repo follow-up note.
6. **`/tasks` slash command** still dispatches (via the existing registry — the TUI just renders its output the same way the old REPL did).
7. **Inside the TUI**, invoke a tool that triggers `task_create` (e.g., spawn an Explore subagent). Confirm a task card appears (rendered from the `task_update` events you wired in Task 2).
8. **Streaming**: send a prompt that elicits a long assistant response. Verify text deltas appear incrementally, not all at once.
9. **Ctrl-C** in the TUI exits cleanly; the daemon lock is released (verified by being able to start `sov` again immediately without "already running").
10. **Unit suite green**: `bun test` is at the target count (~1810+); `bun run typecheck` and `bun run lint` both exit 0.

---

## OPS REPO FOLLOW-UP (out of scope for this plan)

The launchd template in `~/code/sovereign-ai-ops/mission/install.sh` currently runs:
```
harness chat --agent scheduled-mission --state-dir <DIR>
```

After Phase 16.0b, this should be:
```
harness mission run --state-dir <DIR>
```

Required changes:
- Update `install.sh` to invoke the new command.
- Update the `harness --help | grep state-dir` health check to grep against the new location (`harness mission run --help | grep state-dir`).

This is a separate change in a separate repo; not part of this plan, but flag it to the user when the harness-side work is shipped so they can update the ops repo before the next launchd wake fires.
