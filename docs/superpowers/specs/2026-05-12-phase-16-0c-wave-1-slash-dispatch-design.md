# Phase 16.0c Wave 1 — Slash Command Dispatch Design

**Date:** 2026-05-12
**Phase:** 16.0c (the P0 headline of the post-Ink-TUI catch-up phase)
**Wave:** 1 of 7 (decomposition below)
**Author:** brainstorm session

---

## Context

Phase 16.0b (shipped 2026-05-11) replaced the readline `terminalRepl.ts` with an
Ink 5 + React 18 TUI. The slash command registry (`src/commands/`) was orphaned
by that deletion and removed in commit `92953e2`. The Ink TUI ships without any
slash commands — `/help`, `/clear`, `/cost`, `/quit`, etc. all 404 because the
mechanism is gone.

This phase rebuilds slash dispatch on top of the Ink TUI.

## Decomposition

The deleted registry had ~30 commands across 7 files (~4,200 LoC). Many
commands depended on plumbing (session DB, TaskManager construction, compactor,
reviewManager, budget reporter, expand registry) that has not yet been lifted
into `startInkTUI`. Restoring everything in one spec would be a multi-week mega
spec. Per the brainstorming-skill rule on multi-subsystem projects, the full
restore is decomposed into seven waves, each its own spec → plan →
implementation cycle:

| Wave | Scope | New plumbing required |
|---|---|---|
| **1 (this spec)** | Parser + registry + dispatcher + plumbing-light commands: `/help`, `/clear`, `/quit`, `/about`, `/cost`, `/model`, `/config`, `/permissions`, `/tools`, `/skills` | None beyond refs in `startInkTUI` |
| 2 | Session DB lift + `/resume`, `/stats`, `/rollback`, `/export` | `openOrResumeSession` into `startInkTUI`; `SessionMetrics` surface |
| 3 | Compactor + `/compact` | Compactor wired against multi-turn history |
| 4 | TaskManager construction + `/tasks` | Lift `TaskManager` construction into `startInkTUI` (subscription wired) |
| 5 | ReviewManager + `/review` | Lift review fork + memory_propose / skill_propose pathway |
| 6 | Context budget + expand + `/context-budget`, `/expand`, `/init`, `/copy` | Budget audit hook + tool-block expansion registry |
| 7 | Prompt-command pathway + `/commit` | `prompt`-type dispatcher branch; `allowedTools` narrowing |

This spec covers **Wave 1 only**.

## Goal

Restore the slash command dispatch mechanism in the Ink TUI. Ship 10 commands
that need no plumbing beyond what `startInkTUI` already wires. Future waves
attach to the same registry by registering additional commands.

## Architecture

```
Prompt.tsx ──onSubmit(text)──> App.tsx
                                  │
                       text.startsWith('/')?
                          │              │
                         yes             no
                          ▼              ▼
                  useSlashDispatch   useAgentTurn
                          │              │
                  dispatchSlashCommand   runner(prompt) ──> query()
                          │              │
                       result            stream events
                          │              │
                  dispatch(            dispatch(UiEvents)
                  system_message)         │
                          │              ▼
                          └──────> UiState reducer
                                          │
                                          ▼
                                   Transcript renders
```

The dispatch site (`App.tsx`'s `onSubmit` callback) keeps a single `<Prompt>`
input — slash-prefix routing is a closure decision, not a UI-level concern.
Slash output and agent output land in the same transcript via the existing
`system_message` reducer event.

## State plumbing — refs in `startInkTUI`

The runner currently closes over `const history: Message[] = []` and a single
resolved `provider` + `model`. `/clear` and `/model` need to mutate that state
without rebuilding the runner.

Approach: hold mutable values in refs at `startInkTUI` scope. The runner reads
them on every call.

```ts
// src/ui/ink/index.tsx, inside startInkTUI:
const historyRef = { current: [] as Message[] };
const providerRef = { current: resolved.transport };
const modelRef = { current: resolved.model };

const runner: AgentTurnRunner = (prompt: string) => {
  historyRef.current.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
  return runOneTurn({
    history: historyRef.current,
    provider: providerRef.current,
    model: modelRef.current,
    // ...
  });
};
```

Token cost lives in the reducer (`UiState.sessionCost`) since it's reactive UI
state — every turn streams `usage_delta` events that update the status line.

## Module layout

| File | Responsibility | LoC est. |
|---|---|---|
| `src/commands/types.ts` | `CommandContext`, `LocalCommand`, `CommandRegistry`, `CommandDispatchResult` | ~80 |
| `src/commands/registry.ts` | `parseSlashCommand()`, `buildCommandRegistry()`, `dispatchSlashCommand()`, `COMMANDS` array, `formatHelp()` | ~250 |
| `src/commands/info.ts` | `/about`, `/tools`, `/skills`, `/permissions` | ~150 |
| `src/commands/sessionOps.ts` | `/clear`, `/quit`, `/cost`, `/model` | ~150 |
| `src/commands/configCommand.ts` | `/config show \| path \| get \| set \| unset` | ~180 |
| `src/ui/ink/hooks/useSlashDispatch.ts` | React hook: builds `CommandContext`, calls `dispatchSlashCommand`, routes output via dispatch | ~80 |

Edits to existing files:

| File | Change | LoC delta |
|---|---|---|
| `src/ui/ink/index.tsx` | Add refs (`historyRef`, `providerRef`, `modelRef`), build `CommandContext`, pass to `App` | +40 |
| `src/ui/ink/App.tsx` | Route `/`-prefix to slash dispatch vs agent turn | +10 |
| `src/ui/ink/hooks/useAgentTurn.ts` | Dispatch `usage_delta` UiEvent from `StreamEvent.usage_delta` | +15 |
| `src/ui/ink/state/types.ts` | Add `sessionCost` slot to UiState + `usage_delta` + `transcript_cleared` UiEvent variants | +10 |
| `src/ui/ink/state/reducer.ts` | Handle `usage_delta` (accumulate) and `transcript_cleared` (reset) | +20 |

Total: ~1,200 LoC new + ~95 LoC edits. Well under any single-file 800-LoC cap;
each file under the 200–400 line target.

## `CommandContext` (Wave 1)

```ts
import type { Tool } from '../tool/types.js';
import type { SkillRegistry } from '../skills/types.js';
import type { PermissionRuleLayer } from '../config/rules.js';

export type SessionCost = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
};

export type CommandContext = {
  sessionId: string;
  cwd: string;
  providerName: string;            // read from providerRef
  model: string;                   // read from modelRef
  bundlePath: string | null;
  harnessHome: string;
  profileName: string;
  setModel: (m: string) => void;   // mutates modelRef + dispatches status_line_update
  clearHistory: () => string;      // mutates historyRef + dispatches transcript_cleared
  getCost: () => SessionCost;      // reads sessionCost from latest UiState
  tools: ReadonlyArray<Tool<unknown, unknown>>;
  skills: SkillRegistry;
  getPermissions: () => { mode: string; layers: PermissionRuleLayer[] };
  registry: CommandRegistry;
  requestExit: () => void;         // calls onExit
};
```

YAGNI: later-wave fields (`taskManager`, `reviewManager`, `compact`, `rollback`,
`getBudgetReport`, `expandToolBlock`, `getMessages`, `cleanupPhantomReviews`,
`resumeCheckin`, `listSessions`, `getMetrics`, `getLastAssistantText`) are
**not** added in Wave 1. Each later wave extends the type when its commands
land.

## `LocalCommand` shape (Wave 1)

```ts
export type LocalCommand = {
  type: 'local';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  call: (args: string, ctx: CommandContext) => Promise<string>;
};

// Wave 1 ships only LocalCommand. PromptCommand + LocalJSXCommand land in
// Waves 7 + future, not now.
export type SlashCommand = LocalCommand;
export type CommandRegistry = ReadonlyMap<string, SlashCommand>;

export type CommandDispatchResult =
  | { kind: 'local'; output: string }
  | { kind: 'unknown'; output: string };
```

## Parser

```ts
export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) return { name: '', args: '' };
  const firstSpace = withoutSlash.search(/\s/);
  if (firstSpace === -1) return { name: withoutSlash, args: '' };
  return {
    name: withoutSlash.slice(0, firstSpace),
    args: withoutSlash.slice(firstSpace + 1).trim(),
  };
}
```

This is preserved verbatim from the deleted `registry.ts` — it works and its
edge cases are already understood.

## `useSlashDispatch` hook

```ts
import { useCallback } from 'react';
import type { CommandContext } from '../../../commands/types.js';
import { dispatchSlashCommand } from '../../../commands/registry.js';
import type { UiEvent } from '../state/types.js';

export function useSlashDispatch(
  ctx: CommandContext,
  dispatch: (event: UiEvent) => void,
): { readonly dispatch: (text: string) => Promise<void> } {
  const dispatchSlash = useCallback(
    async (text: string): Promise<void> => {
      // Echo the typed command back to the transcript as user input,
      // so the user can scroll back and see what they typed.
      dispatch({ type: 'user_input_submitted', text });
      try {
        const result = await dispatchSlashCommand(text, ctx);
        if (result.output) {
          dispatch({ type: 'system_message', text: result.output });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      }
    },
    [ctx, dispatch],
  );
  return { dispatch: dispatchSlash };
}
```

## `App.tsx` routing edit

```tsx
const { submit } = useAgentTurn(runner, dispatch);
const { dispatch: dispatchSlash } = useSlashDispatch(commandContext, dispatch);

<Prompt
  onSubmit={(text): void => {
    if (text.startsWith('/')) {
      void dispatchSlash(text);
    } else {
      void submit(text);
    }
  }}
  onAbort={onExit}
  disabled={state.status !== 'idle'}
/>
```

`disabled={state.status !== 'idle'}` already gates Enter while the agent is
mid-turn. Slash commands are non-streaming, so they complete synchronously and
don't transition `status` to `thinking` / `tool` — `disabled` won't block the
next user input.

However, an in-flight agent turn **should** block slash commands too (a user
can't `/clear` while a tool is running, since that would orphan the
generator). The `disabled` check in `<Prompt>` already prevents the Enter key
from firing while the turn runs, so this is already handled — confirmed by
re-reading `src/ui/ink/Prompt.tsx:26-32`.

## Commands shipped in Wave 1

### `/help`, `/h`, `/?`
Lists registered commands grouped by category (session / info / config /
other). Output rendered via chalk ANSI inside `system_message` text. Ink's
`<Text>` renders ANSI escape sequences natively (verified by the splash
banner's ANSI usage in `src/ui/splash.ts`).

### `/clear`
Calls `ctx.clearHistory()`, which:
1. Sets `historyRef.current = []`
2. Dispatches `{ type: 'transcript_cleared' }` to the reducer
3. Returns `'history cleared (N messages)'` as a system_message

The reducer's `transcript_cleared` handler resets `transcript: []` and
`sessionCost: zeroCost`.

### `/quit`, `/exit`
Calls `ctx.requestExit()`, which is wired in `startInkTUI` to the same
`onExit` callback used by Ctrl-C. Triggers `daemon.shutdown()` and the
deferred unmount.

### `/about`
Static info: harness version (from `package.json`), profile name,
harnessHome, bundlePath (or 'no bundle'), sessionId, providerName, model.

### `/cost`
Reads `sessionCost` from the latest UiState ref. Formats as USD via
`formatUsd(estimatedUsd)`. Lifetime is the current Ink session — restart
zeros it. (Persistent cost lives in the session DB, which Wave 2 lifts.)

### `/model [provider/model]`
No-arg → prints current `providerName` / `model`. With arg → calls
`ctx.setModel(arg)`, which mutates `modelRef.current` and dispatches
`status_line_update`. No client-side validation; the provider validates on
next turn (matches old terminalRepl behavior). If the arg contains a slash
("anthropic/claude-sonnet-4-6"), `setModel` re-resolves the provider via
`resolveProvider()` and swaps `providerRef.current` too.

### `/config [show | path | get <p> | set <p> <v> | unset <p>]`
Identical handler to the deleted version — pure on `src/config/store`. The
five verbs round-trip through `readConfig` / `writeConfig` with
`SettingsSchema` zod validation on writes.

### `/permissions`
Prints `mode` (default | ask | bypass) + a one-line-per-layer summary of the
persistent permission rule layers (read from `config/rules`).
Session-allow rules render as `[]` until permission prompts are wired in a
later phase — the Ink TUI doesn't have a permission-prompt UI yet, and that
work is outside the seven-wave decomposition above.

### `/tools`
Lists `toolPool` by name + 1-line description. Mirrors the deleted version
in shape; trimmed to omit category headers (categories add complexity
without much benefit at this scale).

### `/skills`
Lists `loadedSkills.skills` similarly — name + description.

## New UiState surface

```ts
// src/ui/ink/state/types.ts:

export type SessionCost = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd: number;
};

export const zeroCost: SessionCost = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
};

export type UiState = {
  // ... existing fields
  readonly sessionCost: SessionCost;
};

export type UiEvent =
  // ... existing variants
  | {
      type: 'usage_delta';
      delta: Partial<Pick<SessionCost, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>>;
      estimatedUsdDelta: number;
    }
  | { type: 'transcript_cleared' };
```

Reducer handlers:

```ts
case 'usage_delta': {
  const cur = state.sessionCost;
  return {
    ...state,
    sessionCost: {
      inputTokens: cur.inputTokens + (event.delta.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (event.delta.outputTokens ?? 0),
      cacheReadTokens: cur.cacheReadTokens + (event.delta.cacheReadTokens ?? 0),
      cacheWriteTokens: cur.cacheWriteTokens + (event.delta.cacheWriteTokens ?? 0),
      estimatedUsd: cur.estimatedUsd + event.estimatedUsdDelta,
    },
  };
}
case 'transcript_cleared':
  return { ...state, transcript: [], sessionCost: zeroCost };
```

`useAgentTurn` dispatches the `usage_delta` event on every `StreamEvent.usage_delta`
it sees from the agent loop, calling `estimateUsd()` from `src/providers/pricing.ts`
inline using the current `providerName` / `model` for rate lookup.

## Reading UiState from CommandContext

`getCost()` needs to read the latest reducer state, but `CommandContext` is
built outside React. Solution: keep a `latestStateRef` updated via an effect
inside `App.tsx`:

```tsx
const latestStateRef = useRef<UiState>(state);
useEffect(() => { latestStateRef.current = state; }, [state]);
```

`CommandContext.getCost = () => latestStateRef.current.sessionCost` then sees
the current value on every invocation. This pattern is reused by future
waves (e.g., `getBudgetReport`, `getMetrics`).

## Error handling

- Unknown command → `unknown command: /foo\n\n<help>` as `system_message`.
- Parser fails on malformed input → `system_message` with usage hint.
- Command handler throws → caught in `useSlashDispatch`, dispatched as
  `system_message` text `error: <msg>`. Mirrors `useAgentTurn`'s catch block.
- `/clear` while turn is in flight → blocked at `<Prompt>` level by
  `disabled` (no special command-level handling needed).

## Testing strategy

Per `~/.claude/rules/ecc/common/testing.md` (80% coverage minimum, AAA structure):

**Unit tests:**
- `tests/commands/registry.test.ts` — `parseSlashCommand` edge cases
  (empty, leading whitespace, trailing whitespace, multiple spaces, no args,
  args with quotes), alias resolution, `dispatchSlashCommand` unknown handler,
  `formatHelp` category grouping.
- `tests/commands/sessionOps.test.ts` — `/clear` mutates a fake historyRef,
  `/quit` calls `requestExit`, `/cost` reads from a fake getter, `/model`
  with various arg shapes (no arg, model-only, provider/model).
- `tests/commands/configCommand.test.ts` — round-trips through a tmp
  `~/.harness/config.json` via env override; covers show/path/get/set/unset.
- `tests/commands/info.test.ts` — `/about`, `/tools`, `/skills`,
  `/permissions` with fake fixtures.

**Integration tests (Ink mount):**
- `tests/ui/ink/useSlashDispatch.test.tsx` — `ink-testing-library` mount;
  submit `/help`, `/cost`, `/clear`; assert reducer dispatches.
- `tests/ui/ink/App.slash-routing.test.tsx` — confirms `/`-prefix vs
  non-slash routing reaches the right hook.
- `tests/ui/ink/reducer.usage.test.ts` — `usage_delta` accumulation,
  `transcript_cleared` resets.

**Semantic test extension:**
- One new case under `tests/semantic/suites/cli-and-repl/`: send `/help`,
  assert listed commands; send `/clear`, send another message, assert
  history-cleared. Run via `bun run test:semantic -- --filter slash`.

Target: 80%+ statement coverage on `src/commands/` and `src/ui/ink/hooks/useSlashDispatch.ts`.

## Non-goals (Wave 1)

- **Tab completion / autocomplete.** Users type the full command name.
  Autocomplete returns in a later phase.
- **Prompt-type commands** (`/commit`). Wave 7. Requires the `prompt`
  dispatcher branch + `allowedTools` narrowing + `getPromptForCommand`
  hook into the runner.
- **`local-jsx` command type.** Drop entirely — the old terminalRepl never
  shipped one and the type carries no benefit at this scale.
- **`/compact`, `/rollback`, `/resume`, `/stats`, `/export`** — Wave 2.
- **`/tasks`** — Wave 4. The Phase 16.0b `task_create` tool already throws
  "no task manager" until Wave 4 lifts the construction.
- **`/review`** — Wave 5.
- **`/context-budget`, `/expand`, `/init`, `/copy`** — Wave 6.
- **Permission-prompt UI.** When a tool wants permission, the Ink TUI
  currently has no prompt surface. That blocks the session-allow rule path
  in `/permissions`. Out of scope here.

## Code quality checklist

- [x] Every new file under 400 LoC (largest is `registry.ts` at ~250).
- [x] No mutation of `UiState` (refs are explicitly mutable; UiState
      remains pure-reducer immutable).
- [x] No magic numbers (all constants named).
- [x] No `any` (`unknown` everywhere user input or external data crosses
      a boundary).
- [x] Every new exported function has explicit parameter + return types.
- [x] CommandContext fields are typed (no implicit `any`).
- [x] Test coverage target: 80%+.

## Gates before merge

- `bun run lint` clean
- `bun run typecheck` clean
- `bun run test` — full unit suite passes (current baseline: 1454/1454)
- `bun run test:semantic -- --filter slash` — the new slash semantic case
  passes
- Manual smoke test: `sov upgrade` → `sov` → confirm `/help`, `/clear`,
  `/cost`, `/quit` work end-to-end
- Update `docs/state-of-build-*.md` with Wave 1 close-out snapshot
- Append to `docs/testing-log-2026-04-27.md`
- Update `docs/semantic-testing.md` coverage inventory + headline count

## Risks

1. **`ink-testing-library` interaction with `useInput`.** Our `<Prompt>` uses
   `useInput`. The library's `stdin.write()` should work, but if not, fall
   back to unit-testing the hook directly with a fake dispatch.
2. **`getCost()` staleness.** The ref pattern depends on the effect firing
   before any command read. React batches effects after render, so a
   command invoked in the same tick as a `usage_delta` could see the
   previous cost. Mitigation: snapshot the value through a `useReducer`
   selector instead of an effect. If staleness shows up in tests, swap to
   the selector pattern.
3. **`chalk` color overflow into `<Text>`.** Ink `<Text>` renders ANSI
   codes from raw strings, but nested `<Text color="...">` can fight ANSI
   resets. Mitigation: keep `system_message` text rendered in a plain
   `<Text>` with no `color=` override. Already the case in
   `src/ui/ink/Transcript.tsx` for system messages — confirmed before
   shipping.

## Open questions for the implementation plan

- Should `/help` cache its rendered string across calls? (Probably yes;
  the registry doesn't change after assembly.)
- Should `/cost` snapshot at command-invocation time or always live-read?
  (Live-read — matches old behavior, and the difference is negligible
  for a non-streaming display.)
- Should `setModel('anthropic/claude-opus-4-7')` validate the model
  against a known list? (No — the provider validates on next call. We'd
  duplicate logic.)

These are not gating; they get resolved in the implementation plan or
during implementation.
