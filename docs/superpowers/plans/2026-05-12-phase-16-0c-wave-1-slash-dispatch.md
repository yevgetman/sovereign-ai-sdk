# Phase 16.0c Wave 1 — Slash Command Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore slash command dispatch in the Ink TUI by shipping a parser, registry, dispatcher, and 10 plumbing-light commands (`/help`, `/clear`, `/quit`, `/about`, `/cost`, `/model`, `/config`, `/permissions`, `/tools`, `/skills`).

**Architecture:** A new `useSlashDispatch` hook sits in parallel to `useAgentTurn`. `App.tsx`'s `onSubmit` routes by `/`-prefix. Mutable runtime state (`history`, `provider`, `model`) lives in refs at `startInkTUI` scope. Reactive UI state (`sessionCost`, `transcript`) lives in the existing reducer. Command output flows back to the transcript via a new `command_output` `TranscriptMessage` variant that renders without dimColor so chalk styling survives.

**Tech Stack:** TypeScript strict, Bun runtime + test runner, Ink 5 + React 18, `ink-testing-library@4` for hook/component tests, `chalk@5` for output styling, Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-05-12-phase-16-0c-wave-1-slash-dispatch-design.md`

---

## File Map

**Create:**
- `src/commands/types.ts` — types (`CommandContext`, `LocalCommand`, `CommandRegistry`, `CommandDispatchResult`, `SessionCost`)
- `src/commands/registry.ts` — parser, registry builder, dispatcher, help formatter, `COMMANDS` array
- `src/commands/info.ts` — `/about`, `/tools`, `/skills`, `/permissions`
- `src/commands/sessionOps.ts` — `/clear`, `/quit`, `/cost`, `/model`
- `src/commands/configCommand.ts` — `/config`
- `src/ui/ink/hooks/useSlashDispatch.ts` — React hook
- `tests/commands/registry.test.ts`
- `tests/commands/sessionOps.test.ts`
- `tests/commands/configCommand.test.ts`
- `tests/commands/info.test.ts`
- `tests/ui/ink/useSlashDispatch.test.tsx`
- `tests/ui/ink/reducer.usage.test.ts`
- `tests/ui/ink/App.slash-routing.test.tsx`
- `tests/semantic/suites/cli-and-repl/slash-help.yaml` (or matching naming)

**Modify:**
- `src/ui/ink/state/types.ts` — add `sessionCost`, `usage_delta`, `transcript_cleared`, `command_output` TranscriptMessage variant
- `src/ui/ink/state/reducer.ts` — handle new events
- `src/ui/ink/hooks/useAgentTurn.ts` — dispatch `usage_delta` from `StreamEvent.usage_delta`
- `src/ui/ink/Transcript.tsx` — render the new `command_output` variant
- `src/ui/ink/App.tsx` — accept `commandContext` prop, route `/`-prefix to `useSlashDispatch`, hold `latestStateRef`
- `src/ui/ink/index.tsx` — refs for runtime state, build `CommandContext`, pass to `App`

---

## Task 1: Define CommandContext + LocalCommand types

**Files:**
- Create: `src/commands/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) renders from these shapes.

import type { PermissionRuleLayer } from '../config/rules.js';
import type { SkillRegistry } from '../skills/types.js';
import type { Tool } from '../tool/types.js';

export type SessionCost = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd: number;
};

export const zeroCost: SessionCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedUsd: 0,
};

export type PermissionsSnapshot = {
  readonly mode: 'default' | 'ask' | 'bypass';
  readonly layers: ReadonlyArray<PermissionRuleLayer>;
};

export type CommandContext = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly providerName: string;
  readonly model: string;
  readonly bundlePath: string | null;
  readonly harnessHome: string;
  readonly profileName: string;
  readonly setModel: (m: string) => void;
  readonly clearHistory: () => string;
  readonly getCost: () => SessionCost;
  readonly tools: ReadonlyArray<Tool<unknown, unknown>>;
  readonly skills: SkillRegistry;
  readonly getPermissions: () => PermissionsSnapshot;
  readonly registry: CommandRegistry;
  readonly requestExit: () => void;
};

export type LocalCommand = {
  readonly type: 'local';
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly description: string;
  readonly usage?: string;
  readonly call: (args: string, ctx: CommandContext) => Promise<string>;
};

export type SlashCommand = LocalCommand;

export type CommandRegistry = ReadonlyMap<string, SlashCommand>;

export type CommandDispatchResult =
  | { readonly kind: 'local'; readonly output: string }
  | { readonly kind: 'unknown'; readonly output: string };
```

- [ ] **Step 2: Verify imports resolve**

Run: `bun run typecheck`
Expected: `error TS2724` or similar pointing only at unused imports from this file (the file isn't imported yet), OR clean. If `tsc` complains about unused exports — ignore (this is a pure type module).

- [ ] **Step 3: Commit**

```bash
git add src/commands/types.ts
git commit -m "feat(commands): define CommandContext + LocalCommand types for Wave 1"
```

---

## Task 2: Slash parser + parseSlashCommand tests

**Files:**
- Create: `src/commands/registry.ts`
- Test: `tests/commands/registry.test.ts`

- [ ] **Step 1: Write the failing parser test**

```ts
// tests/commands/registry.test.ts
import { describe, expect, test } from 'bun:test';
import { parseSlashCommand } from '../../src/commands/registry.js';

describe('parseSlashCommand', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('  hello /world')).toBeNull();
  });

  test('parses bare slash as empty name', () => {
    expect(parseSlashCommand('/')).toEqual({ name: '', args: '' });
  });

  test('parses single-word command', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
  });

  test('parses command with single arg', () => {
    expect(parseSlashCommand('/model claude-opus')).toEqual({
      name: 'model',
      args: 'claude-opus',
    });
  });

  test('parses command with multi-word args (collapses leading whitespace only)', () => {
    expect(parseSlashCommand('/config set foo.bar baz')).toEqual({
      name: 'config',
      args: 'set foo.bar baz',
    });
  });

  test('trims surrounding whitespace', () => {
    expect(parseSlashCommand('   /help   ')).toEqual({ name: 'help', args: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/registry.test.ts`
Expected: FAIL — cannot import `parseSlashCommand` (file doesn't exist yet).

- [ ] **Step 3: Implement parseSlashCommand**

Create `src/commands/registry.ts`:

```ts
// Slash-command registry + dispatcher. UI-agnostic — every surface
// (Ink TUI, future Telegram, Slack) uses this single source of truth.

import type {
  CommandDispatchResult,
  CommandRegistry,
  SlashCommand,
} from './types.js';

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

export function buildCommandRegistry(commands: ReadonlyArray<SlashCommand>): CommandRegistry {
  const registry = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!registry.has(command.name)) registry.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      if (!registry.has(alias)) registry.set(alias, command);
    }
  }
  return registry;
}

export async function dispatchSlashCommand(
  rawInput: string,
  ctx: import('./types.js').CommandContext,
): Promise<CommandDispatchResult> {
  const parsed = parseSlashCommand(rawInput);
  if (!parsed) return { kind: 'unknown', output: 'not a slash command' };
  if (!parsed.name) {
    return { kind: 'unknown', output: 'empty command\n\ntype /help to list available commands' };
  }
  const command = ctx.registry.get(parsed.name);
  if (!command) {
    return {
      kind: 'unknown',
      output: `unknown command: /${parsed.name}\n\ntype /help to list available commands`,
    };
  }
  return { kind: 'local', output: await command.call(parsed.args, ctx) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands/registry.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/registry.ts tests/commands/registry.test.ts
git commit -m "feat(commands): slash parser + dispatcher scaffold"
```

---

## Task 3: buildCommandRegistry + dispatchSlashCommand tests

**Files:**
- Modify: `tests/commands/registry.test.ts`

- [ ] **Step 1: Append registry + dispatch tests**

```ts
import type { CommandContext, SlashCommand } from '../../src/commands/types.js';
import { buildCommandRegistry, dispatchSlashCommand } from '../../src/commands/registry.js';

function fakeCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    type: 'local',
    name: 'fake',
    description: 'fake command',
    call: async () => 'fake output',
    ...overrides,
  };
}

function fakeCtx(registry: ReturnType<typeof buildCommandRegistry>): CommandContext {
  return {
    sessionId: 's1',
    cwd: '/tmp',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: null,
    harnessHome: '/tmp/harness',
    profileName: 'default',
    setModel: () => {},
    clearHistory: () => 'cleared',
    getCost: () => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
    }),
    tools: [],
    skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
    getPermissions: () => ({ mode: 'default', layers: [] }),
    registry,
    requestExit: () => {},
  };
}

describe('buildCommandRegistry', () => {
  test('registers names and aliases without overwriting earlier entries', () => {
    const a = fakeCommand({ name: 'help', aliases: ['h', '?'] });
    const b = fakeCommand({ name: 'h' });  // collides with alias
    const registry = buildCommandRegistry([a, b]);
    expect(registry.get('help')).toBe(a);
    expect(registry.get('h')).toBe(a); // earlier wins
    expect(registry.get('?')).toBe(a);
  });
});

describe('dispatchSlashCommand', () => {
  test('returns unknown for non-slash input', async () => {
    const registry = buildCommandRegistry([fakeCommand()]);
    const result = await dispatchSlashCommand('hello', fakeCtx(registry));
    expect(result.kind).toBe('unknown');
  });

  test('returns unknown with help hint for unregistered command', async () => {
    const registry = buildCommandRegistry([fakeCommand()]);
    const result = await dispatchSlashCommand('/nope', fakeCtx(registry));
    expect(result.kind).toBe('unknown');
    expect(result.output).toContain('unknown command: /nope');
    expect(result.output).toContain('type /help');
  });

  test('calls the registered handler', async () => {
    const command = fakeCommand({
      name: 'echo',
      call: async (args) => `echo: ${args}`,
    });
    const registry = buildCommandRegistry([command]);
    const result = await dispatchSlashCommand('/echo hello world', fakeCtx(registry));
    expect(result).toEqual({ kind: 'local', output: 'echo: hello world' });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/commands/registry.test.ts`
Expected: PASS — 9 tests total now.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/registry.test.ts
git commit -m "test(commands): registry build + dispatch unit tests"
```

---

## Task 4: UiState additions — sessionCost, usage_delta, transcript_cleared, command_output

**Files:**
- Modify: `src/ui/ink/state/types.ts`
- Test: `tests/ui/ink/reducer.usage.test.ts`

- [ ] **Step 1: Edit `src/ui/ink/state/types.ts`** — add SessionCost slot, new variants

Replace the entire file with:

```ts
// Phase 16.0b/c — Ink TUI state shape and event vocabulary.

export type UiStatus = 'idle' | 'thinking' | 'tool';

export type SessionCost = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd: number;
};

export const zeroCost: SessionCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedUsd: 0,
};

export type TranscriptMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly streaming?: boolean }
  | { readonly role: 'system'; readonly text: string }
  // Phase 16.0c — command output rendered without dimColor so chalk
  // styling (e.g. /help category headers) survives.
  | { readonly role: 'command_output'; readonly text: string }
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
  readonly sessionCost: SessionCost;
  readonly statusLine: Readonly<{
    cwd: string;
    profile: string;
    provider?: string;
    model?: string;
    sessionCostUsd?: number;
  }>;
};

export type UsageDeltaPayload = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
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
  | { type: 'system_message'; text: string }
  | { type: 'command_output'; text: string }
  | { type: 'usage_delta'; delta: UsageDeltaPayload; estimatedUsdDelta: number }
  | { type: 'transcript_cleared' };
```

- [ ] **Step 2: Write the failing reducer test**

Create `tests/ui/ink/reducer.usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { initialUiState, reduce } from '../../../src/ui/ink/state/reducer.js';

describe('reducer — usage_delta', () => {
  test('accumulates input + output tokens', () => {
    const after = reduce(initialUiState, {
      type: 'usage_delta',
      delta: { inputTokens: 100, outputTokens: 50 },
      estimatedUsdDelta: 0.01,
    });
    expect(after.sessionCost.inputTokens).toBe(100);
    expect(after.sessionCost.outputTokens).toBe(50);
    expect(after.sessionCost.estimatedUsd).toBeCloseTo(0.01, 5);
  });

  test('two deltas accumulate', () => {
    const a = reduce(initialUiState, {
      type: 'usage_delta',
      delta: { inputTokens: 100 },
      estimatedUsdDelta: 0.01,
    });
    const b = reduce(a, {
      type: 'usage_delta',
      delta: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 10 },
      estimatedUsdDelta: 0.02,
    });
    expect(b.sessionCost.inputTokens).toBe(150);
    expect(b.sessionCost.outputTokens).toBe(30);
    expect(b.sessionCost.cacheReadTokens).toBe(10);
    expect(b.sessionCost.estimatedUsd).toBeCloseTo(0.03, 5);
  });
});

describe('reducer — transcript_cleared', () => {
  test('resets transcript and sessionCost', () => {
    const seeded = reduce(initialUiState, { type: 'user_input_submitted', text: 'hi' });
    const billed = reduce(seeded, {
      type: 'usage_delta',
      delta: { inputTokens: 100 },
      estimatedUsdDelta: 0.05,
    });
    expect(billed.transcript.length).toBe(1);
    expect(billed.sessionCost.estimatedUsd).toBeCloseTo(0.05, 5);

    const cleared = reduce(billed, { type: 'transcript_cleared' });
    expect(cleared.transcript).toEqual([]);
    expect(cleared.sessionCost.estimatedUsd).toBe(0);
  });
});

describe('reducer — command_output', () => {
  test('appends command_output transcript message', () => {
    const after = reduce(initialUiState, { type: 'command_output', text: 'help text' });
    expect(after.transcript).toHaveLength(1);
    expect(after.transcript[0]).toEqual({ role: 'command_output', text: 'help text' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/ui/ink/reducer.usage.test.ts`
Expected: FAIL — reducer doesn't yet handle the new events.

- [ ] **Step 4: Update the reducer**

Edit `src/ui/ink/state/reducer.ts`. Replace the whole file with:

```ts
import type { TranscriptMessage, UiEvent, UiState } from './types.js';
import { zeroCost } from './types.js';

export const initialUiState: UiState = {
  transcript: [],
  status: 'idle',
  tasks: {},
  sessionCost: zeroCost,
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
    case 'command_output':
      return {
        ...state,
        transcript: [...state.transcript, { role: 'command_output', text: event.text }],
      };
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
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/ui/ink/reducer.usage.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Run the full unit suite to confirm no regressions**

Run: `bun run test`
Expected: 1454/1454 (or higher) — none broken.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ink/state/types.ts src/ui/ink/state/reducer.ts tests/ui/ink/reducer.usage.test.ts
git commit -m "feat(ui): UiState gets sessionCost + usage_delta/transcript_cleared/command_output events"
```

---

## Task 5: Transcript renders the command_output variant

**Files:**
- Modify: `src/ui/ink/Transcript.tsx`

- [ ] **Step 1: Add the new variant to the MessageRow switch**

Edit `src/ui/ink/Transcript.tsx`. In the `MessageRow` switch, add this case **before** `case 'tool_use':`:

```tsx
case 'command_output':
  // No dimColor so chalk-styled output from /help, /tools, etc. renders
  // at full saturation. Italic also dropped — command output is plain.
  return (
    <Box>
      <Text>{msg.text}</Text>
    </Box>
  );
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: clean (or only the 2 pre-existing `shellSemantics.ts` warnings).

- [ ] **Step 4: Run the full unit suite**

Run: `bun run test`
Expected: 1454/1454 — none broken.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ink/Transcript.tsx
git commit -m "feat(ui): Transcript renders command_output variant without dimColor"
```

---

## Task 6: useAgentTurn dispatches usage_delta from StreamEvent.usage_delta

**Files:**
- Modify: `src/ui/ink/hooks/useAgentTurn.ts`

- [ ] **Step 1: Inspect the existing useAgentTurn handler**

The file currently handles `text_delta`, `message_stop`, and `assistant_message` from `StreamEvent`. We add a branch for `usage_delta` that calls `estimateCostUsd` and dispatches the reducer event.

- [ ] **Step 2: Edit the hook**

Replace the entire file with:

```ts
// Phase 16.0b/c — drives one user turn against the harness agent loop.
// Iterates the agent stream and translates StreamEvents + Messages
// into UiEvents for the Ink TUI reducer. Status transitions to
// 'thinking' on turn start and back to 'idle' on turn end.
//
// Wave 1 adds usage_delta forwarding so /cost can read accumulated
// session token totals + estimated USD from the reducer.

import { useCallback } from 'react';
import type { Message, StreamEvent, Terminal } from '../../../core/types.js';
import { estimateCostUsd } from '../../../providers/pricing.js';
import type { UiEvent } from '../state/types.js';

export type AgentTurnRunner = (prompt: string) => AsyncGenerator<StreamEvent | Message, Terminal>;

export type AgentTurnSubmit = (text: string) => Promise<void>;

export type AgentTurnOpts = {
  readonly providerName: string;
  readonly model: string;
};

export function useAgentTurn(
  runner: AgentTurnRunner,
  dispatch: (event: UiEvent) => void,
  opts: AgentTurnOpts,
): { readonly submit: AgentTurnSubmit } {
  const submit = useCallback<AgentTurnSubmit>(
    async (text: string): Promise<void> => {
      dispatch({ type: 'user_input_submitted', text });
      dispatch({ type: 'agent_turn_start' });
      try {
        const gen = runner(text);
        for (;;) {
          const step = await gen.next();
          if (step.done) break;
          const ev = step.value;
          if (!ev || typeof ev !== 'object') continue;

          if ('role' in ev) {
            if (ev.role === 'user') {
              for (const block of ev.content) {
                if (block.type !== 'tool_result') continue;
                dispatch({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: block.content,
                });
              }
            }
            continue;
          }

          if (!('type' in ev)) continue;
          if (ev.type === 'text_delta') {
            dispatch({ type: 'assistant_text_delta', delta: ev.text });
            continue;
          }
          if (ev.type === 'message_stop') {
            dispatch({ type: 'assistant_message_complete' });
            continue;
          }
          if (ev.type === 'assistant_message') {
            for (const block of ev.message.content) {
              if (block.type === 'tool_use') {
                dispatch({ type: 'tool_use', toolName: block.name, input: block.input });
              }
            }
            continue;
          }
          if (ev.type === 'usage_delta') {
            const usage = ev.usage;
            const estimatedUsdDelta = estimateCostUsd(opts.providerName, opts.model, usage);
            dispatch({
              type: 'usage_delta',
              delta: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadInputTokens,
                cacheWriteTokens: usage.cacheCreationInputTokens,
              },
              estimatedUsdDelta,
            });
            continue;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      } finally {
        dispatch({ type: 'agent_turn_end' });
      }
    },
    [runner, dispatch, opts.providerName, opts.model],
  );
  return { submit };
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: TWO errors at `src/ui/ink/App.tsx` — `useAgentTurn` now requires an `opts` argument that App.tsx isn't passing. We fix App.tsx in Task 19. For now, type errors here are expected.

If you want to keep the suite green between tasks, temporarily make `opts` optional with a default in App.tsx — but the cleanest path is to fix App.tsx in the next Task batch.

- [ ] **Step 4: Commit (failing typecheck is OK at this checkpoint)**

```bash
git add src/ui/ink/hooks/useAgentTurn.ts
git commit -m "feat(ui): useAgentTurn forwards usage_delta to reducer (App.tsx wires opts in Task 19)"
```

---

## Task 7: /about command

**Files:**
- Create: `src/commands/info.ts` (partial — `/about` only)
- Test: `tests/commands/info.test.ts`

- [ ] **Step 1: Write the failing /about test**

Create `tests/commands/info.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ABOUT_COMMAND } from '../../src/commands/info.js';
import type { CommandContext } from '../../src/commands/types.js';

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'sess-abc12345',
    cwd: '/tmp/work',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: '/tmp/bundle',
    harnessHome: '/tmp/.harness',
    profileName: 'default',
    setModel: () => {},
    clearHistory: () => 'cleared',
    getCost: () => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
    }),
    tools: [],
    skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
    getPermissions: () => ({ mode: 'default', layers: [] }),
    registry: new Map(),
    requestExit: () => {},
    ...overrides,
  };
}

describe('/about', () => {
  test('prints harness identity fields', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx());
    expect(out).toContain('sovereign-ai-harness');
    expect(out).toContain('profile: default');
    expect(out).toContain('provider: anthropic');
    expect(out).toContain('model: claude-sonnet-4-6');
    expect(out).toContain('bundle: /tmp/bundle');
    expect(out).toContain('cwd: /tmp/work');
  });

  test('renders "no bundle" when bundlePath is null', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx({ bundlePath: null }));
    expect(out).toContain('bundle: no bundle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/info.test.ts`
Expected: FAIL — `src/commands/info.ts` doesn't exist.

- [ ] **Step 3: Create info.ts with /about**

Create `src/commands/info.ts`:

```ts
// Info-shaped slash commands: /about, /tools, /skills, /permissions.

import type { LocalCommand } from './types.js';

const HARNESS_NAME = 'sovereign-ai-harness';

export const ABOUT_COMMAND: LocalCommand = {
  type: 'local',
  name: 'about',
  description: 'Show harness identity, profile, provider, and bundle.',
  call: async (_args, ctx) => {
    const lines = [
      HARNESS_NAME,
      `profile: ${ctx.profileName}`,
      `harness home: ${ctx.harnessHome}`,
      `provider: ${ctx.providerName}`,
      `model: ${ctx.model}`,
      `bundle: ${ctx.bundlePath ?? 'no bundle'}`,
      `cwd: ${ctx.cwd}`,
      `session: ${ctx.sessionId}`,
    ];
    return lines.join('\n');
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands/info.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/info.ts tests/commands/info.test.ts
git commit -m "feat(commands): /about prints harness identity"
```

---

## Task 8: /help command + formatHelp

**Files:**
- Modify: `src/commands/registry.ts` (add `formatHelp` + `HELP_COMMAND`)
- Modify: `tests/commands/registry.test.ts`

- [ ] **Step 1: Write the failing /help test**

Append to `tests/commands/registry.test.ts`:

```ts
import { formatHelp, HELP_COMMAND } from '../../src/commands/registry.js';

describe('/help', () => {
  test('formatHelp lists every command name with description', () => {
    const cmd1: SlashCommand = {
      type: 'local', name: 'one', description: 'first cmd', call: async () => '',
    };
    const cmd2: SlashCommand = {
      type: 'local', name: 'two', description: 'second cmd', aliases: ['t'], call: async () => '',
    };
    const registry = buildCommandRegistry([cmd1, cmd2]);
    const out = formatHelp(registry);
    expect(out).toContain('/one');
    expect(out).toContain('first cmd');
    expect(out).toContain('/two');
    expect(out).toContain('second cmd');
    expect(out).toContain('(t)'); // alias hint
  });

  test('HELP_COMMAND.call returns formatHelp output', async () => {
    const ctx = fakeCtx(buildCommandRegistry([HELP_COMMAND]));
    const out = await HELP_COMMAND.call('', ctx);
    expect(out).toContain('/help');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/registry.test.ts`
Expected: FAIL — `formatHelp` and `HELP_COMMAND` not exported.

- [ ] **Step 3: Append formatHelp + HELP_COMMAND to registry.ts**

Append to `src/commands/registry.ts`:

```ts
import chalk from 'chalk';
import type { LocalCommand } from './types.js';

export function formatHelp(registry: CommandRegistry): string {
  const unique = Array.from(new Set(registry.values()));
  unique.sort((a, b) => a.name.localeCompare(b.name));
  const longest = Math.max(...unique.map((c) => c.name.length + aliasSuffix(c).length));
  const lines: string[] = [chalk.bold('slash commands'), ''];
  for (const command of unique) {
    const head = `/${command.name}${aliasSuffix(command)}`;
    const pad = ' '.repeat(Math.max(0, longest + 1 - head.length));
    lines.push(`  ${chalk.cyan(head)}${pad}  ${chalk.gray(command.description)}`);
    if (command.usage) {
      lines.push(`  ${' '.repeat(longest + 1)}  ${chalk.dim(command.usage)}`);
    }
  }
  lines.push('');
  lines.push(chalk.dim('hint: type / followed by a command name.'));
  return lines.join('\n');
}

function aliasSuffix(command: LocalCommand): string {
  const aliases = command.aliases ?? [];
  if (aliases.length === 0) return '';
  return ` (${aliases.join(', ')})`;
}

export const HELP_COMMAND: LocalCommand = {
  type: 'local',
  name: 'help',
  aliases: ['h', '?'],
  description: 'List available slash commands.',
  call: async (_args, ctx) => formatHelp(ctx.registry),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/registry.test.ts`
Expected: PASS — 11 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/commands/registry.ts tests/commands/registry.test.ts
git commit -m "feat(commands): /help lists registered commands with chalk styling"
```

---

## Task 9: /clear command

**Files:**
- Create: `src/commands/sessionOps.ts` (partial — `/clear` only)
- Test: `tests/commands/sessionOps.test.ts`

- [ ] **Step 1: Write the failing /clear test**

Create `tests/commands/sessionOps.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { CLEAR_COMMAND } from '../../src/commands/sessionOps.js';
import type { CommandContext } from '../../src/commands/types.js';

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'sess',
    cwd: '/tmp',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: null,
    harnessHome: '/tmp/.harness',
    profileName: 'default',
    setModel: () => {},
    clearHistory: () => 'history cleared (3 messages)',
    getCost: () => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
    }),
    tools: [],
    skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
    getPermissions: () => ({ mode: 'default', layers: [] }),
    registry: new Map(),
    requestExit: () => {},
    ...overrides,
  };
}

describe('/clear', () => {
  test('invokes ctx.clearHistory and returns its message', async () => {
    let called = 0;
    const ctx = fakeCtx({
      clearHistory: () => {
        called++;
        return 'history cleared (5 messages)';
      },
    });
    const out = await CLEAR_COMMAND.call('', ctx);
    expect(called).toBe(1);
    expect(out).toContain('history cleared');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: FAIL — `src/commands/sessionOps.ts` doesn't exist.

- [ ] **Step 3: Create sessionOps.ts with /clear**

Create `src/commands/sessionOps.ts`:

```ts
// Session-shaped slash commands: /clear, /quit, /cost, /model.

import type { LocalCommand } from './types.js';

export const CLEAR_COMMAND: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and reset session cost.',
  call: async (_args, ctx) => ctx.clearHistory(),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sessionOps.ts tests/commands/sessionOps.test.ts
git commit -m "feat(commands): /clear delegates to ctx.clearHistory"
```

---

## Task 10: /quit + /exit commands

**Files:**
- Modify: `src/commands/sessionOps.ts`
- Modify: `tests/commands/sessionOps.test.ts`

- [ ] **Step 1: Append the failing /quit test**

Append to `tests/commands/sessionOps.test.ts`:

```ts
import { QUIT_COMMAND } from '../../src/commands/sessionOps.js';

describe('/quit', () => {
  test('invokes ctx.requestExit and returns empty string', async () => {
    let called = 0;
    const ctx = fakeCtx({ requestExit: () => { called++; } });
    const out = await QUIT_COMMAND.call('', ctx);
    expect(called).toBe(1);
    expect(out).toBe('');
  });

  test('has /exit as an alias', () => {
    expect(QUIT_COMMAND.aliases).toContain('exit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: FAIL — `QUIT_COMMAND` not exported.

- [ ] **Step 3: Append QUIT_COMMAND to sessionOps.ts**

Append:

```ts
export const QUIT_COMMAND: LocalCommand = {
  type: 'local',
  name: 'quit',
  aliases: ['exit'],
  description: 'Exit the harness.',
  call: async (_args, ctx) => {
    ctx.requestExit();
    return '';
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sessionOps.ts tests/commands/sessionOps.test.ts
git commit -m "feat(commands): /quit (/exit) calls ctx.requestExit"
```

---

## Task 11: /cost command

**Files:**
- Modify: `src/commands/sessionOps.ts`
- Modify: `tests/commands/sessionOps.test.ts`

- [ ] **Step 1: Append the failing /cost test**

Append to `tests/commands/sessionOps.test.ts`:

```ts
import { COST_COMMAND } from '../../src/commands/sessionOps.js';

describe('/cost', () => {
  test('renders token totals and USD estimate', async () => {
    const ctx = fakeCtx({
      getCost: () => ({
        inputTokens: 1500,
        outputTokens: 320,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        estimatedUsd: 0.0042,
      }),
    });
    const out = await COST_COMMAND.call('', ctx);
    expect(out).toContain('input: 1,500');
    expect(out).toContain('output: 320');
    expect(out).toContain('cache read: 100');
    expect(out).toContain('cache write: 50');
    expect(out).toContain('$0.0042');
  });

  test('renders $0.00 when no usage yet', async () => {
    const ctx = fakeCtx(); // default zero
    const out = await COST_COMMAND.call('', ctx);
    expect(out).toContain('input: 0');
    expect(out).toContain('$0.0000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: FAIL — `COST_COMMAND` not exported.

- [ ] **Step 3: Append COST_COMMAND to sessionOps.ts**

Append:

```ts
import { formatUsd } from '../providers/pricing.js';

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export const COST_COMMAND: LocalCommand = {
  type: 'local',
  name: 'cost',
  description: 'Show token usage and estimated cost for this session.',
  call: async (_args, ctx) => {
    const cost = ctx.getCost();
    return [
      'session cost',
      `  input:        ${formatTokens(cost.inputTokens)} tokens`,
      `  output:       ${formatTokens(cost.outputTokens)} tokens`,
      `  cache read:   ${formatTokens(cost.cacheReadTokens)} tokens`,
      `  cache write:  ${formatTokens(cost.cacheWriteTokens)} tokens`,
      `  estimated:    ${formatUsd(cost.estimatedUsd)}`,
    ].join('\n');
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sessionOps.ts tests/commands/sessionOps.test.ts
git commit -m "feat(commands): /cost prints token totals and USD estimate"
```

---

## Task 12: /model command

**Files:**
- Modify: `src/commands/sessionOps.ts`
- Modify: `tests/commands/sessionOps.test.ts`

- [ ] **Step 1: Append the failing /model test**

Append:

```ts
import { MODEL_COMMAND } from '../../src/commands/sessionOps.js';

describe('/model', () => {
  test('with no args prints current provider/model', async () => {
    const ctx = fakeCtx({ providerName: 'anthropic', model: 'claude-sonnet-4-6' });
    const out = await MODEL_COMMAND.call('', ctx);
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-sonnet-4-6');
  });

  test('with arg invokes ctx.setModel and confirms', async () => {
    let captured = '';
    const ctx = fakeCtx({
      setModel: (m: string) => { captured = m; },
    });
    const out = await MODEL_COMMAND.call('claude-opus-4-7', ctx);
    expect(captured).toBe('claude-opus-4-7');
    expect(out).toContain('claude-opus-4-7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: FAIL — `MODEL_COMMAND` not exported.

- [ ] **Step 3: Append MODEL_COMMAND to sessionOps.ts**

Append:

```ts
export const MODEL_COMMAND: LocalCommand = {
  type: 'local',
  name: 'model',
  description: 'Show or change the active provider/model.',
  usage: '/model [<provider/model>|<model>]',
  call: async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return `current: ${ctx.providerName}/${ctx.model}\n\nusage: ${MODEL_COMMAND.usage ?? ''}`;
    }
    ctx.setModel(trimmed);
    return `model set to ${trimmed}\n(provider validates on next turn)`;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/sessionOps.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sessionOps.ts tests/commands/sessionOps.test.ts
git commit -m "feat(commands): /model shows current or calls ctx.setModel"
```

---

## Task 13: /tools and /skills commands

**Files:**
- Modify: `src/commands/info.ts`
- Modify: `tests/commands/info.test.ts`

- [ ] **Step 1: Append the failing /tools + /skills tests**

Append:

```ts
import { TOOLS_COMMAND, SKILLS_COMMAND } from '../../src/commands/info.js';
import type { Tool } from '../../src/tool/types.js';

function fakeTool(name: string, description: string): Tool<unknown, unknown> {
  return {
    name, description,
    inputSchema: { type: 'object' },
    call: async () => ({ outputs: [{ type: 'text', text: 'ok' }] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    userFacingName: () => name,
  } as unknown as Tool<unknown, unknown>;
}

describe('/tools', () => {
  test('lists each tool by name with description', async () => {
    const ctx = fakeCtx({
      tools: [fakeTool('Read', 'Read files'), fakeTool('Edit', 'Edit files')],
    });
    const out = await TOOLS_COMMAND.call('', ctx);
    expect(out).toContain('Read');
    expect(out).toContain('Read files');
    expect(out).toContain('Edit');
  });

  test('handles empty tool pool', async () => {
    const out = await TOOLS_COMMAND.call('', fakeCtx({ tools: [] }));
    expect(out).toContain('no tools');
  });
});

describe('/skills', () => {
  test('lists each skill by name with description', async () => {
    const skills = {
      skills: [
        { name: 'brainstorming', description: 'design dialogue', triggers: [], toolset: [] },
        { name: 'writing-plans', description: 'plan writer', triggers: [], toolset: [] },
      ],
      byTool: new Map(),
    } as unknown as CommandContext['skills'];
    const ctx = fakeCtx({ skills });
    const out = await SKILLS_COMMAND.call('', ctx);
    expect(out).toContain('brainstorming');
    expect(out).toContain('design dialogue');
    expect(out).toContain('writing-plans');
  });

  test('handles empty skill registry', async () => {
    const skills = { skills: [], byTool: new Map() } as unknown as CommandContext['skills'];
    const out = await SKILLS_COMMAND.call('', fakeCtx({ skills }));
    expect(out).toContain('no skills');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/info.test.ts`
Expected: FAIL — `TOOLS_COMMAND`, `SKILLS_COMMAND` not exported.

- [ ] **Step 3: Append to info.ts**

Append:

```ts
export const TOOLS_COMMAND: LocalCommand = {
  type: 'local',
  name: 'tools',
  description: 'List tools available in this session.',
  call: async (_args, ctx) => {
    if (ctx.tools.length === 0) return 'no tools loaded';
    const lines = ['tools', ''];
    const longest = Math.max(...ctx.tools.map((t) => t.name.length));
    for (const tool of ctx.tools) {
      const pad = ' '.repeat(Math.max(0, longest + 1 - tool.name.length));
      lines.push(`  ${tool.name}${pad}  ${tool.description ?? ''}`);
    }
    return lines.join('\n');
  },
};

export const SKILLS_COMMAND: LocalCommand = {
  type: 'local',
  name: 'skills',
  description: 'List skills available in this session.',
  call: async (_args, ctx) => {
    if (ctx.skills.skills.length === 0) return 'no skills loaded';
    const lines = ['skills', ''];
    const longest = Math.max(...ctx.skills.skills.map((s) => s.name.length));
    for (const skill of ctx.skills.skills) {
      const pad = ' '.repeat(Math.max(0, longest + 1 - skill.name.length));
      lines.push(`  ${skill.name}${pad}  ${skill.description ?? ''}`);
    }
    return lines.join('\n');
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/info.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/info.ts tests/commands/info.test.ts
git commit -m "feat(commands): /tools and /skills list active registries"
```

---

## Task 14: /permissions command

**Files:**
- Modify: `src/commands/info.ts`
- Modify: `tests/commands/info.test.ts`

- [ ] **Step 1: Append the failing /permissions test**

Append:

```ts
import { PERMISSIONS_COMMAND } from '../../src/commands/info.js';

describe('/permissions', () => {
  test('prints mode and "no layers" when empty', async () => {
    const ctx = fakeCtx({
      getPermissions: () => ({ mode: 'default', layers: [] }),
    });
    const out = await PERMISSIONS_COMMAND.call('', ctx);
    expect(out).toContain('mode: default');
    expect(out).toContain('no permission rule layers configured');
  });

  test('prints each layer with rule count', async () => {
    const ctx = fakeCtx({
      getPermissions: () => ({
        mode: 'ask',
        layers: [
          {
            source: 'user',
            path: '/home/user/.harness/settings.json',
            rules: [
              { tool: 'Bash', match: 'git status', behavior: 'allow' as const },
              { tool: 'Read', match: '*', behavior: 'allow' as const },
            ],
          } as unknown as ReturnType<typeof ctx.getPermissions>['layers'][number],
        ],
      }),
    });
    const out = await PERMISSIONS_COMMAND.call('', ctx);
    expect(out).toContain('mode: ask');
    expect(out).toContain('user');
    expect(out).toContain('2 rule');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/info.test.ts`
Expected: FAIL — `PERMISSIONS_COMMAND` not exported.

- [ ] **Step 3: Append PERMISSIONS_COMMAND to info.ts**

Append:

```ts
export const PERMISSIONS_COMMAND: LocalCommand = {
  type: 'local',
  name: 'permissions',
  description: 'Show the current permission mode and rule layers.',
  call: async (_args, ctx) => {
    const snap = ctx.getPermissions();
    const lines = [`mode: ${snap.mode}`, ''];
    if (snap.layers.length === 0) {
      lines.push('no permission rule layers configured');
      return lines.join('\n');
    }
    for (const layer of snap.layers) {
      const ruleCount = layer.rules.length;
      const plural = ruleCount === 1 ? 'rule' : 'rules';
      lines.push(`  ${layer.source} (${layer.path})  ${ruleCount} ${plural}`);
    }
    return lines.join('\n');
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/info.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/info.ts tests/commands/info.test.ts
git commit -m "feat(commands): /permissions shows mode and rule layers"
```

---

## Task 15: /config command — show, path, get, set, unset

**Files:**
- Create: `src/commands/configCommand.ts`
- Test: `tests/commands/configCommand.test.ts`

- [ ] **Step 1: Inspect `src/config/store.ts` for available helpers**

Run: `grep -n "^export" src/config/store.ts`
Expected output mentions: `readConfig`, `writeConfig`, `getAt`, `setAt`, `unsetAt`, `formatValue`, `parseValueLiteral`, `resolveConfigPath`, `redactSecrets`. These are the helpers the deleted version used and they're still present.

- [ ] **Step 2: Write the failing /config tests**

Create `tests/commands/configCommand.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_COMMAND } from '../../src/commands/configCommand.js';
import type { CommandContext } from '../../src/commands/types.js';

let tmpHome: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'sov-cfg-test-'));
  originalEnv = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = tmpHome;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

function fakeCtx(): CommandContext {
  return {
    sessionId: 's', cwd: '/tmp',
    providerName: 'anthropic', model: 'claude-sonnet-4-6',
    bundlePath: null, harnessHome: tmpHome, profileName: 'default',
    setModel: () => {}, clearHistory: () => 'cleared',
    getCost: () => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
    }),
    tools: [],
    skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
    getPermissions: () => ({ mode: 'default', layers: [] }),
    registry: new Map(), requestExit: () => {},
  };
}

describe('/config', () => {
  test('no-arg shows current config redacted', async () => {
    const out = await CONFIG_COMMAND.call('', fakeCtx());
    expect(out).toContain('{');
  });

  test('"path" returns the config path', async () => {
    const out = await CONFIG_COMMAND.call('path', fakeCtx());
    expect(out).toContain('config.json');
  });

  test('set + get round-trips a primitive', async () => {
    await CONFIG_COMMAND.call('set defaultProvider ollama', fakeCtx());
    const out = await CONFIG_COMMAND.call('get defaultProvider', fakeCtx());
    expect(out).toContain('ollama');
  });

  test('unset removes a key', async () => {
    await CONFIG_COMMAND.call('set defaultProvider ollama', fakeCtx());
    await CONFIG_COMMAND.call('unset defaultProvider', fakeCtx());
    const out = await CONFIG_COMMAND.call('get defaultProvider', fakeCtx());
    expect(out).toContain('undefined');
  });

  test('unknown verb returns usage', async () => {
    const out = await CONFIG_COMMAND.call('frobnicate', fakeCtx());
    expect(out.toLowerCase()).toContain('usage');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/commands/configCommand.test.ts`
Expected: FAIL — `src/commands/configCommand.ts` doesn't exist.

- [ ] **Step 4: Create configCommand.ts**

Create `src/commands/configCommand.ts`:

```ts
// /config slash command — show, path, get, set, unset. Pure on
// src/config/store, so behavior matches the `sovereign config` CLI verbs.

import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from '../config/store.js';
import type { LocalCommand } from './types.js';

const USAGE = '/config [show | path | get <dotpath> | set <dotpath> <value> | unset <dotpath>]';

export const CONFIG_COMMAND: LocalCommand = {
  type: 'local',
  name: 'config',
  description: 'View or change durable user-level config (~/.harness/config.json).',
  usage: USAGE,
  call: async (args, _ctx) => handleConfig(args),
};

async function handleConfig(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const verb = parts[0] ?? 'show';

  if (verb === 'show' || verb === '') {
    const cfg = await readConfig();
    return JSON.stringify(redactSecrets(cfg), null, 2);
  }

  if (verb === 'path') {
    return resolveConfigPath();
  }

  if (verb === 'get') {
    const path = parts[1];
    if (!path) return `usage: ${USAGE}`;
    const cfg = await readConfig();
    const value = getAt(cfg, path);
    return value === undefined ? 'undefined' : formatValue(value);
  }

  if (verb === 'set') {
    const path = parts[1];
    if (!path || parts.length < 3) return `usage: ${USAGE}`;
    const raw = parts.slice(2).join(' ');
    const value = parseValueLiteral(raw);
    const cfg = await readConfig();
    const updated = setAt(cfg, path, value);
    await writeConfig(updated);
    return `set ${path} = ${formatValue(value)}`;
  }

  if (verb === 'unset') {
    const path = parts[1];
    if (!path) return `usage: ${USAGE}`;
    const cfg = await readConfig();
    const updated = unsetAt(cfg, path);
    await writeConfig(updated);
    return `unset ${path}`;
  }

  return `usage: ${USAGE}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/commands/configCommand.test.ts`
Expected: PASS — 5 tests.

If any of the `set` / `get` / `unset` helpers have a different signature than expected, read `src/config/store.ts` and adjust the imports. The names above are verbatim from the deleted `src/commands/registry.ts:8-18`, so they should match.

- [ ] **Step 6: Commit**

```bash
git add src/commands/configCommand.ts tests/commands/configCommand.test.ts
git commit -m "feat(commands): /config restores show/path/get/set/unset verbs"
```

---

## Task 16: Wire the COMMANDS array

**Files:**
- Modify: `src/commands/registry.ts`

- [ ] **Step 1: Replace the import section + add COMMANDS export**

Edit `src/commands/registry.ts`. Below the existing exports, add:

```ts
import { ABOUT_COMMAND, PERMISSIONS_COMMAND, SKILLS_COMMAND, TOOLS_COMMAND } from './info.js';
import { CLEAR_COMMAND, COST_COMMAND, MODEL_COMMAND, QUIT_COMMAND } from './sessionOps.js';
import { CONFIG_COMMAND } from './configCommand.js';

export const WAVE_1_COMMANDS: ReadonlyArray<SlashCommand> = [
  HELP_COMMAND,
  CLEAR_COMMAND,
  QUIT_COMMAND,
  COST_COMMAND,
  MODEL_COMMAND,
  CONFIG_COMMAND,
  ABOUT_COMMAND,
  PERMISSIONS_COMMAND,
  TOOLS_COMMAND,
  SKILLS_COMMAND,
];
```

- [ ] **Step 2: Write a smoke test that confirms every command is dispatchable**

Append to `tests/commands/registry.test.ts`:

```ts
import { WAVE_1_COMMANDS } from '../../src/commands/registry.js';

describe('WAVE_1_COMMANDS', () => {
  test('every command has a unique name', () => {
    const names = WAVE_1_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every command dispatches without throwing on empty args', async () => {
    const registry = buildCommandRegistry([...WAVE_1_COMMANDS]);
    const ctx = fakeCtx(registry);
    for (const command of WAVE_1_COMMANDS) {
      const out = await dispatchSlashCommand(`/${command.name}`, ctx);
      expect(out.kind).toBe('local');
    }
  });

  test('includes the 10 Wave 1 commands', () => {
    const names = WAVE_1_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual([
      'about', 'clear', 'config', 'cost', 'help',
      'model', 'permissions', 'quit', 'skills', 'tools',
    ]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/commands/`
Expected: PASS — all command tests green.

- [ ] **Step 4: Commit**

```bash
git add src/commands/registry.ts tests/commands/registry.test.ts
git commit -m "feat(commands): wire WAVE_1_COMMANDS array (10 commands)"
```

---

## Task 17: useSlashDispatch hook

**Files:**
- Create: `src/ui/ink/hooks/useSlashDispatch.ts`
- Test: `tests/ui/ink/useSlashDispatch.test.tsx`

- [ ] **Step 1: Write the failing hook test**

Create `tests/ui/ink/useSlashDispatch.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { useSlashDispatch } from '../../../src/ui/ink/hooks/useSlashDispatch.js';
import { buildCommandRegistry, HELP_COMMAND } from '../../../src/commands/registry.js';
import type { CommandContext } from '../../../src/commands/types.js';
import type { UiEvent } from '../../../src/ui/ink/state/types.js';

function HostHelp({
  ctx,
  onEvent,
}: {
  ctx: CommandContext;
  onEvent: (e: UiEvent) => void;
}): JSX.Element {
  const { dispatch } = useSlashDispatch(ctx, onEvent);
  React.useEffect(() => {
    void dispatch('/help');
  }, [dispatch]);
  return <></>;
}

describe('useSlashDispatch', () => {
  test('routes /help output to command_output dispatch', async () => {
    const events: UiEvent[] = [];
    const ctx: CommandContext = {
      sessionId: 's', cwd: '/tmp',
      providerName: 'anthropic', model: 'claude-sonnet-4-6',
      bundlePath: null, harnessHome: '/tmp', profileName: 'default',
      setModel: () => {}, clearHistory: () => 'cleared',
      getCost: () => ({
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
      }),
      tools: [],
      skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
      getPermissions: () => ({ mode: 'default', layers: [] }),
      registry: buildCommandRegistry([HELP_COMMAND]),
      requestExit: () => {},
    };
    render(<HostHelp ctx={ctx} onEvent={(e) => events.push(e)} />);
    // Wait one tick for the effect + async dispatch.
    await new Promise((r) => setTimeout(r, 50));
    const types = events.map((e) => e.type);
    expect(types).toContain('user_input_submitted');
    expect(types).toContain('command_output');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/ink/useSlashDispatch.test.tsx`
Expected: FAIL — hook file doesn't exist.

- [ ] **Step 3: Create the hook**

Create `src/ui/ink/hooks/useSlashDispatch.ts`:

```ts
// Phase 16.0c Wave 1 — routes slash-prefixed input through the registry.
// Sits parallel to useAgentTurn; App.tsx's onSubmit chooses based on
// the leading '/' character.

import { useCallback } from 'react';
import { dispatchSlashCommand } from '../../../commands/registry.js';
import type { CommandContext } from '../../../commands/types.js';
import type { UiEvent } from '../state/types.js';

export type SlashDispatch = (text: string) => Promise<void>;

export function useSlashDispatch(
  ctx: CommandContext,
  dispatch: (event: UiEvent) => void,
): { readonly dispatch: SlashDispatch } {
  const dispatchSlash = useCallback<SlashDispatch>(
    async (text: string): Promise<void> => {
      dispatch({ type: 'user_input_submitted', text });
      try {
        const result = await dispatchSlashCommand(text, ctx);
        if (result.output) {
          if (result.kind === 'unknown') {
            dispatch({ type: 'system_message', text: result.output });
          } else {
            dispatch({ type: 'command_output', text: result.output });
          }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/ink/useSlashDispatch.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ink/hooks/useSlashDispatch.ts tests/ui/ink/useSlashDispatch.test.tsx
git commit -m "feat(ui): useSlashDispatch routes slash input via the registry"
```

---

## Task 18: App.tsx — add commandContext prop, route /-prefix, add latestStateRef

**Files:**
- Modify: `src/ui/ink/App.tsx`

- [ ] **Step 1: Replace App.tsx**

Replace the entire file with:

```tsx
// Phase 16.0b/c — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. Inputs arrive
// either as agent prompts (useAgentTurn) or as slash commands
// (useSlashDispatch); the /-prefix decides the path.

import { Box } from 'ink';
import type { JSX } from 'react';
import { useEffect, useReducer } from 'react';
import type { CommandContext } from '../../commands/types.js';
import type { DaemonEventBus } from '../../daemon/eventBus.js';
import { Prompt } from './Prompt.js';
import { StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import type { AgentTurnRunner } from './hooks/useAgentTurn.js';
import { useAgentTurn } from './hooks/useAgentTurn.js';
import { useBusSubscription } from './hooks/useBusSubscription.js';
import { useSlashDispatch } from './hooks/useSlashDispatch.js';
import { initialUiState, reduce } from './state/reducer.js';
import type { UiEvent, UiState } from './state/types.js';

type AppProps = {
  readonly runner: AgentTurnRunner;
  readonly bus: DaemonEventBus;
  readonly cwd: string;
  readonly profile: string;
  readonly provider: string;
  readonly model: string;
  readonly commandContext: CommandContext;
  /** Receives the latest UiState by reference; the host uses this in
   *  CommandContext.getCost so commands see post-streaming values. */
  readonly latestStateRef: { current: UiState };
  /** Host writes the reducer dispatch fn here on mount so out-of-React
   *  callbacks (CommandContext.clearHistory, setModel) can emit
   *  transcript_cleared and status_line_update events. */
  readonly uiDispatchRef: { current: ((e: UiEvent) => void) | null };
  readonly onExit: () => void;
};

export function App({
  runner,
  bus,
  cwd,
  profile,
  provider,
  model,
  commandContext,
  latestStateRef,
  uiDispatchRef,
  onExit,
}: AppProps): JSX.Element {
  const statusLine: UiState['statusLine'] = { cwd, profile, provider, model };
  const [state, dispatch] = useReducer(reduce, { ...initialUiState, statusLine });
  // Keep the host's refs in sync so out-of-React getters/setters
  // (CommandContext.getCost / clearHistory / setModel) interact with the
  // latest reducer state and can emit dispatch events.
  useEffect(() => {
    latestStateRef.current = state;
  }, [state, latestStateRef]);
  useEffect(() => {
    uiDispatchRef.current = dispatch;
    return () => {
      uiDispatchRef.current = null;
    };
  }, [uiDispatchRef]);
  useBusSubscription(bus, dispatch);
  const { submit } = useAgentTurn(runner, dispatch, { providerName: provider, model });
  const { dispatch: dispatchSlash } = useSlashDispatch(commandContext, dispatch);

  return (
    <Box flexDirection="column">
      <Box flexGrow={1} flexDirection="column">
        <Transcript messages={state.transcript} />
      </Box>
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
      <StatusLine statusLine={state.statusLine} status={state.status} />
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: ONE remaining error at `src/ui/ink/index.tsx` — it doesn't yet pass `commandContext` or `latestStateRef`. Fixed in Task 19.

- [ ] **Step 3: Write a routing test**

Create `tests/ui/ink/App.slash-routing.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../../src/ui/ink/App.js';
import { buildCommandRegistry, HELP_COMMAND } from '../../../src/commands/registry.js';
import type { CommandContext } from '../../../src/commands/types.js';
import type { DaemonEventBus } from '../../../src/daemon/eventBus.js';
import type { Message, StreamEvent, Terminal } from '../../../src/core/types.js';

function makeBus(): DaemonEventBus {
  return {
    emit: () => true,
    on: () => () => {},
    off: () => {},
    once: () => () => {},
  } as unknown as DaemonEventBus;
}

async function* noopRunner(_p: string): AsyncGenerator<StreamEvent | Message, Terminal> {
  return { reason: 'done' } as Terminal;
}

describe('App slash routing', () => {
  test('renders without crashing with commandContext wired', () => {
    const ctx: CommandContext = {
      sessionId: 's', cwd: '/tmp',
      providerName: 'anthropic', model: 'claude-sonnet-4-6',
      bundlePath: null, harnessHome: '/tmp', profileName: 'default',
      setModel: () => {}, clearHistory: () => 'cleared',
      getCost: () => ({
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
      }),
      tools: [],
      skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
      getPermissions: () => ({ mode: 'default', layers: [] }),
      registry: buildCommandRegistry([HELP_COMMAND]),
      requestExit: () => {},
    };
    const latestStateRef = { current: undefined as unknown as Parameters<typeof App>[0]['latestStateRef']['current'] };
    const uiDispatchRef: { current: null | ((e: never) => void) } = { current: null };
    const { lastFrame } = render(
      <App
        runner={noopRunner}
        bus={makeBus()}
        cwd="/tmp"
        profile="default"
        provider="anthropic"
        model="claude-sonnet-4-6"
        commandContext={ctx}
        latestStateRef={latestStateRef}
        uiDispatchRef={uiDispatchRef as Parameters<typeof App>[0]['uiDispatchRef']}
        onExit={() => {}}
      />,
    );
    expect(lastFrame()).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the routing test**

Run: `bun test tests/ui/ink/App.slash-routing.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ink/App.tsx tests/ui/ink/App.slash-routing.test.tsx
git commit -m "feat(ui): App routes /-prefix via useSlashDispatch + holds latestStateRef"
```

---

## Task 19: index.tsx — refs for runtime state + CommandContext

**Files:**
- Modify: `src/ui/ink/index.tsx`

- [ ] **Step 1: Replace startInkTUI's body**

Replace the body of `startInkTUI` (lines from `const home = ...` through the end of the function) with the following. Imports also need adjustment at the top.

Top-of-file additions:

```ts
import type { CommandContext, PermissionsSnapshot } from '../../commands/types.js';
import { buildCommandRegistry, WAVE_1_COMMANDS } from '../../commands/registry.js';
import type { UiEvent, UiState } from './state/types.js';
import type { LLMProvider } from '../../providers/types.js';
```

If `LLMProvider` isn't the actual exported type name, run `grep -nE "^export (type|interface) LLMProvider|^export type Provider\b" src/providers/types.ts` and use whatever names the transport type. The Wave 1 stub leaves permission layers as `[]` (the permission-prompt UI isn't wired in this wave); loading from settings files is a Wave 2+ follow-up.

Body replacement (everything from `const home` through the existing `try { ... } finally { ... }` block):

```ts
  const home = resolveHarnessHome();
  const profileName = getActiveProfile();
  const daemon = startDaemon({ harnessHome: home });

  const bundlePath = opts.bundlePath ?? getDefaultBundlePath();
  const bundle = await loadBundleIfPresent(bundlePath);
  const userSettings = readConfig();
  const projectScope = resolveProjectScope({
    cwd: process.cwd(),
    bundle: bundle ?? null,
    harnessHome: home,
  });
  const memoryManager = createDefaultMemoryManager(home, projectScope);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();
  const loadedAgents = await loadAgents({
    harnessHome: home,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });
  const loadedSkills = await loadSkills({
    harnessHome: home,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });

  const resolved = resolveProvider(undefined, undefined);
  const cacheEnabled = true;
  const sessionId = `${SESSION_ID_PREFIX}-${process.pid}-${Date.now()}`;

  const toolContext: ToolContext = {
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId,
    harnessHome: home,
    memoryManager,
    agents: loadedAgents,
    projectScope,
  };
  const toolPool: Tool<unknown, unknown>[] = assembleToolPool(toolContext);
  const systemPrompt: SystemSegment[] = buildSystemSegments({
    ...(bundle ? { bundle } : {}),
    tools: toolPool,
    skills: loadedSkills.skills,
    cwd: process.cwd(),
    cacheEnabled,
    projectScope,
  });

  // Phase 16.0c Wave 1 — mutable runtime state lives in refs at this scope.
  // /clear and /model reach in via CommandContext; the runner reads on each
  // call so changes take effect on the next user turn.
  const historyRef: { current: Message[] } = { current: [] };
  const providerRef: { current: LLMProvider } = { current: resolved.transport };
  const modelRef: { current: string } = { current: resolved.model };
  const providerNameRef: { current: string } = {
    current: String(resolved.metadata.provider ?? ''),
  };

  const runner: AgentTurnRunner = (prompt: string) => {
    historyRef.current.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    return runOneTurn({
      history: historyRef.current,
      toolPool,
      toolContext,
      systemPrompt,
      provider: providerRef.current,
      model: modelRef.current,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
      memoryManager,
      sessionId,
      cacheEnabled,
    });
  };

  // Splash banner — same as the prior wiring; written before render() so
  // it lands in scroll-back above Ink's live region.
  const providerName = providerNameRef.current;
  const authLabel = (() => {
    if (providerName === 'ollama') return chalk.gray('local (no key)');
    if (providerName === 'router') return chalk.gray('router-managed');
    return chalk.gray('API Key');
  })();
  const splash = renderSplash({
    providerLabel: providerName,
    authLabel,
    model: modelRef.current,
    bundlePath: bundlePath ?? null,
    permissionMode: userSettings.permissionMode ?? 'default',
    toolCount: toolPool.length,
    cacheOn: cacheEnabled,
    sessionLabel: `new ${sessionId.slice(0, 8)}`,
    exitHint: 'Ctrl-C to exit',
  });
  process.stdout.write(`${splash}\n`);

  // latestStateRef updated by App's effect; CommandContext.getCost reads it.
  // uiDispatchRef written by App on mount so out-of-React callbacks
  // (clearHistory, setModel) can emit reducer events.
  const latestStateRef: { current: UiState | undefined } = { current: undefined };
  const uiDispatchRef: { current: ((e: UiEvent) => void) | null } = { current: null };

  const getPermissions = (): PermissionsSnapshot => ({
    mode: userSettings.permissionMode ?? 'default',
    layers: [],  // Loading from settings files lands in a later wave.
  });

  let exitRequested = false;
  let instance: ReturnType<typeof render> | undefined;
  const onExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    daemon.shutdown();
    setTimeout(() => instance?.unmount(), 0);
  };

  // Build CommandContext. The registry is self-referential (commands need
  // ctx.registry so /help can introspect), so we build the map first, then
  // the context, then the App.
  const registry = buildCommandRegistry(WAVE_1_COMMANDS);
  const commandContext: CommandContext = {
    sessionId,
    cwd: process.cwd(),
    get providerName() { return providerNameRef.current; },
    get model() { return modelRef.current; },
    bundlePath: bundlePath ?? null,
    harnessHome: home,
    profileName,
    setModel: (m: string): void => {
      // Accept either "provider/model" or "model"; re-resolve only when
      // a slash is present.
      if (m.includes('/')) {
        const [maybeProvider, maybeModel] = m.split('/', 2) as [string, string];
        const newResolved = resolveProvider(maybeProvider, maybeModel);
        providerRef.current = newResolved.transport;
        modelRef.current = newResolved.model;
        providerNameRef.current = String(newResolved.metadata.provider ?? maybeProvider);
      } else {
        modelRef.current = m;
      }
      uiDispatchRef.current?.({
        type: 'status_line_update',
        patch: { provider: providerNameRef.current, model: modelRef.current },
      });
    },
    clearHistory: (): string => {
      const cleared = historyRef.current.length;
      historyRef.current = [];
      uiDispatchRef.current?.({ type: 'transcript_cleared' });
      return `history cleared (${cleared} message${cleared === 1 ? '' : 's'})`;
    },
    getCost: () => latestStateRef.current?.sessionCost ?? {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0,
    },
    tools: toolPool,
    skills: loadedSkills,
    getPermissions,
    registry,
    requestExit: onExit,
  };

  instance = render(
    <App
      runner={runner}
      bus={daemon.bus}
      cwd={process.cwd()}
      profile={profileName}
      provider={providerName}
      model={modelRef.current}
      commandContext={commandContext}
      latestStateRef={latestStateRef as { current: UiState }}
      uiDispatchRef={uiDispatchRef}
      onExit={onExit}
    />,
  );

  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    daemon.shutdown();
    await memoryManager.onSessionEnd('ink-tui-exit');
    await memoryManager.shutdown();
  }
}
```

Note the cast `latestStateRef as { current: UiState }` — at first render `current` is `undefined`, but App's effect populates it on the first commit. We narrow at the App boundary because no input can reach `useSlashDispatch` until App is mounted. The `??` fallback in `getCost` covers the impossible-but-typesafe pre-mount window.

`uiDispatchRef` is the same pattern: App writes the reducer dispatch fn into it on mount, so `clearHistory` and `setModel` (out-of-React callbacks) can emit `transcript_cleared` / `status_line_update` events. The `?.` call site keeps it safe if a command somehow fires before mount.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run the full unit suite**

Run: `bun run test`
Expected: 1454+/1454+ — none broken. New tests (commands + reducer.usage + useSlashDispatch + App.slash-routing) add ~25 new tests.

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ink/index.tsx src/ui/ink/App.tsx
git commit -m "feat(ui): wire CommandContext + refs into startInkTUI; route /-prefix to dispatch"
```

---

## Task 20: Manual smoke test

**Files:** None (verification).

- [ ] **Step 1: Build + upgrade global sov binary**

Run: `sov upgrade`
Expected: refreshes `~/.bun/install/global/` to HEAD.

- [ ] **Step 2: Launch Ink TUI**

Run: `sov`
Expected: SOV splash banner, then live region with `❯ ` prompt.

- [ ] **Step 3: Try /help**

Type `/help`, press Enter.
Expected: command list with all 10 commands by name + description, chalk-colored where applicable.

- [ ] **Step 4: Try /about**

Type `/about`, press Enter.
Expected: harness identity block listing profile, harness home, provider, model, bundle path, cwd, session id.

- [ ] **Step 5: Try /cost**

Type `/cost`, press Enter.
Expected: zero-valued cost block.

- [ ] **Step 6: Try a real prompt + /cost**

Type `hello`, press Enter. After response completes, type `/cost`.
Expected: input/output tokens non-zero; USD estimate non-zero.

- [ ] **Step 7: Try /clear**

Type `/clear`, press Enter.
Expected: transcript wiped; system_message confirming the count.

- [ ] **Step 8: Try /model with no args**

Type `/model`, press Enter.
Expected: prints `current: <provider>/<model>`.

- [ ] **Step 9: Try /config show**

Type `/config show`, press Enter.
Expected: JSON dump of the active config.

- [ ] **Step 10: Try /quit**

Type `/quit`, press Enter.
Expected: clean exit, daemon lock released. Run `cat ~/.harness/locks/default.lock` — should not exist (or be empty).

- [ ] **Step 11: Verify Ctrl-C still works**

Run `sov` again, press Ctrl-C.
Expected: same clean-exit path as `/quit`.

If any step fails, fix and re-run from Step 1.

---

## Task 21: Semantic test extension

**Files:**
- Create: `tests/semantic/suites/<appropriate-bucket>/slash-help.yaml` (or `.json` — match existing semantic suite format by inspecting `tests/semantic/suites/`)
- Modify: `docs/semantic-testing.md` — bump headline count + coverage inventory

- [ ] **Step 1: Inspect semantic suite layout**

Run: `ls tests/semantic/suites/`
Expected: list of bucket directories. Pick the one most relevant to "CLI / REPL surface" — likely something like `cli-and-repl/` or `core/`. Read 2-3 existing cases to match format.

- [ ] **Step 2: Author the new case**

Create a case that exercises `/help` and `/clear`:

```yaml
# tests/semantic/suites/<bucket>/slash-help-and-clear.yaml
id: slash-help-and-clear
description: /help lists registered commands; /clear wipes history
turns:
  - user: "/help"
    assertions:
      - kind: contains
        text: "/help"
      - kind: contains
        text: "/clear"
      - kind: contains
        text: "/cost"
  - user: "hello"
  - user: "/clear"
    assertions:
      - kind: contains
        text: "history cleared"
  - user: "/cost"
    assertions:
      - kind: contains
        text: "input: 0"
```

Match the EXACT field names (`id`, `turns`, `assertions`, etc.) used by existing YAML cases. The skeleton above is illustrative; the real schema is whatever the harness's semantic runner reads.

- [ ] **Step 3: Run the new case**

Run: `bun run test:semantic -- --filter slash-help-and-clear`
Expected: PASS.

- [ ] **Step 4: Update docs/semantic-testing.md**

Open `docs/semantic-testing.md`. Add one row to the coverage inventory and bump the headline test count by 1. Add the new case to the "when to run / when to extend" table mapping (changed-area → filter) if there's a relevant entry for slash commands.

- [ ] **Step 5: Commit**

```bash
git add tests/semantic/suites/ docs/semantic-testing.md
git commit -m "test(semantic): /help and /clear round-trip case"
```

---

## Task 22: Documentation updates

**Files:**
- Create: `docs/state-of-build-2026-05-12.md` (close-out snapshot)
- Modify: `docs/testing-log-2026-04-27.md`

- [ ] **Step 1: Append a testing-log entry**

Append to `docs/testing-log-2026-04-27.md` (use the existing format — check the previous entries):

```markdown
## 2026-05-12 — Phase 16.0c Wave 1 (slash dispatch)

**Scope:** Wave 1 ship — parser + registry + dispatcher + 10 plumbing-light commands.

**Automated:**
- `bun run typecheck` — clean
- `bun run lint` — clean (2 pre-existing shellSemantics warnings)
- `bun run test` — N/N pass (delta from baseline 1454 = +~25)
- `bun run test:semantic -- --filter slash-help-and-clear` — PASS

**Manual:**
- Launched `sov` after `sov upgrade`; verified /help, /about, /cost, /clear, /model, /config show, /quit, /tools, /skills, /permissions all dispatch.
- Verified Ctrl-C and /quit both trigger the clean-exit path (daemon lock released).

**Result:** Wave 1 shipped. Follow-up waves (2-7) bring back the remaining ~20 commands as session DB, TaskManager, compactor, etc. are lifted.
```

- [ ] **Step 2: Write the state-of-build close-out**

Create `docs/state-of-build-2026-05-12.md`:

```markdown
# State of build — 2026-05-12

**Branch:** master
**HEAD:** <commit SHA of the final Wave 1 commit>
**Suite:** N unit / 59 semantic

## Phase 16.0c Wave 1 — slash command dispatch (shipped)

- Parser + registry + dispatcher (`src/commands/types.ts`, `src/commands/registry.ts`)
- 10 commands (`src/commands/info.ts`, `src/commands/sessionOps.ts`, `src/commands/configCommand.ts`)
- New `useSlashDispatch` hook routes `/`-prefix input via the registry
- App.tsx adds `commandContext`, `latestStateRef`, `uiDispatchRef` props; routes /-prefix in onSubmit
- index.tsx holds refs for `history`, `provider`, `model`; builds `CommandContext`; passes everything into `App`
- Reducer extended with `sessionCost`, `usage_delta`, `transcript_cleared`, `command_output` variants
- useAgentTurn forwards `StreamEvent.usage_delta` to the reducer via `estimateCostUsd`
- Transcript renders the new `command_output` variant without dimColor

## What's next

Wave 2 — session DB lift + `/resume`, `/stats`, `/rollback`, `/export`. See `docs/superpowers/specs/2026-05-12-phase-16-0c-wave-1-slash-dispatch-design.md` §Decomposition for the full seven-wave table.

## Open backlog

Item 17 (eval-gated auto-promote, P4) remains open from the post-Phase-13.4 backlog.
```

- [ ] **Step 3: Commit**

```bash
git add docs/state-of-build-2026-05-12.md docs/testing-log-2026-04-27.md
git commit -m "docs: Phase 16.0c Wave 1 close-out snapshot + testing log"
```

- [ ] **Step 4: Push + sov upgrade**

```bash
git push origin master
sov upgrade
```

- [ ] **Step 5: Final smoke test**

Run `sov` once more after the upgrade to confirm everything works end-to-end against the freshly-installed binary.

---

## Self-Review Notes

**Spec coverage check:**
- Parser, registry, dispatcher → Tasks 2, 3, 16 ✓
- 10 commands → Tasks 7-15 ✓
- `useSlashDispatch` hook → Task 17 ✓
- App.tsx routing + latestStateRef → Task 18 ✓
- index.tsx refs + CommandContext → Task 19 ✓
- Reducer additions → Task 4 ✓
- `useAgentTurn` usage_delta forwarding → Task 6 ✓
- Transcript `command_output` rendering → Task 5 ✓
- Test coverage (unit + Ink + semantic) → Tasks 2, 3, 4, 7-15, 17, 18, 21 ✓
- Documentation gates → Task 22 ✓

**Known plan gaps (acknowledged):**
- `loadPermissionRuleLayers` import in Task 19 may need a different name — verified during implementation. Layers temporarily stub to `[]`, surfaced as a Wave-1-follow-up. This matches the spec's note that the permission-prompt UI is out of scope.
- Semantic test YAML in Task 21 is illustrative — author should match the actual schema by reading 2-3 existing cases first.
- Step counts in Task 22 use `N` as a placeholder for the unit suite total at close — fill in during implementation.

These placeholders are explicit and surfaced for the implementer; they're not silent TBDs.
