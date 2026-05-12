# maxToolCallsBeforeCheckin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `settings.behavior.maxToolCallsBeforeCheckin` — when set, the turn loop pauses after N cumulative tool calls and asks the user whether to continue, rather than running autonomously to completion.

**Architecture:** The config schema gets a new `behavior` sub-object. `query.ts` accumulates a per-turn tool-call counter and returns a new `'checkin'` terminal reason when the limit is hit. The REPL surfaces a message and sets a `checkinPending` flag; a new `/continue` slash command re-enters the model turn using the already-accumulated history.

**Tech Stack:** TypeScript / Bun, Zod schemas, existing `query()`/`Terminal`/`QueryParams` types, `CommandContext` / slash-command registry.

---

## File map

| File | Change |
|---|---|
| `src/config/schema.ts` | New `BehaviorSchema`; add `behavior` to `SettingsSchema` |
| `src/core/types.ts` | Add `'checkin'` + `toolCallCount?` to `Terminal`; add `maxToolCallsBeforeCheckin?` to `QueryParams` |
| `src/tasks/manager.ts` | Add `case 'checkin'` to `mapTerminalToState` |
| `src/core/query.ts` | `totalToolCallCount` counter; return `'checkin'` terminal |
| `src/commands/types.ts` | Add `resumeCheckin?` to `CommandContext` |
| `src/commands/registry.ts` | Register `/continue` command; add to `COMMAND_CATEGORIES` |
| `src/ui/terminalRepl.ts` | Handle `'checkin'` terminal; `isContinuation` flag in `runModelTurn`; pass setting; wire `resumeCheckin` in `commandContext()` |
| `tests/config/schema.test.ts` | Add `behavior` schema cases |
| `tests/core/query.test.ts` | Add checkin counter + terminal cases |
| `tests/commands/continue.test.ts` | New file — `/continue` command unit tests |

---

## Task 1: Config schema + core types + tasks manager

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/core/types.ts`
- Modify: `src/tasks/manager.ts`
- Test: `tests/config/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/config/schema.test.ts` after the existing `describe` blocks:

```typescript
describe('SettingsSchema — behavior block', () => {
  test('accepts behavior.maxToolCallsBeforeCheckin as a positive integer', () => {
    expect(() =>
      SettingsSchema.parse({ behavior: { maxToolCallsBeforeCheckin: 10 } }),
    ).not.toThrow();
  });

  test('rejects behavior.maxToolCallsBeforeCheckin = 0 (must be positive)', () => {
    expect(() =>
      SettingsSchema.parse({ behavior: { maxToolCallsBeforeCheckin: 0 } }),
    ).toThrow();
  });

  test('rejects unknown keys under behavior (strict mode)', () => {
    expect(() =>
      SettingsSchema.parse({ behavior: { unknownField: true } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/julie/code/sovereign-ai-harness
bun test tests/config/schema.test.ts
```

Expected: FAIL — `behavior` key not recognized (strict mode rejects it).

- [ ] **Step 3: Add `BehaviorSchema` and wire into `SettingsSchema`**

In `src/config/schema.ts`, add the new schema just before `export const SettingsSchema`:

```typescript
/** Backlog item 24 — cost-control knobs for interactive sessions.
 *  All fields optional; defaults documented at the call site. */
const BehaviorSchema = z
  .object({
    /** When set, the turn loop pauses after this many cumulative tool
     *  calls in a single user turn and asks the user whether to continue.
     *  Default unset (no limit). Useful for vague prompts that might
     *  trigger unintended long autonomous runs. */
    maxToolCallsBeforeCheckin: z.number().int().positive().optional(),
  })
  .strict();
```

Then inside `SettingsSchema`'s `.object({...})`, add after `learning`:

```typescript
    behavior: BehaviorSchema.optional(),
```

- [ ] **Step 4: Add `'checkin'` to `Terminal` and `maxToolCallsBeforeCheckin` to `QueryParams`**

In `src/core/types.ts`, change the `Terminal` type:

```typescript
export type Terminal = {
  reason: 'completed' | 'max_tokens' | 'max_turns' | 'error' | 'interrupted' | 'checkin';
  error?: Error;
  /** Set when reason === 'checkin': total tool calls accumulated in this user turn. */
  toolCallCount?: number;
};
```

In `src/core/types.ts`, add to `QueryParams` after the existing `maxTurns` field:

```typescript
  /** When set, the turn loop pauses after this many cumulative tool calls
   *  and returns terminal reason 'checkin'. The caller (REPL) surfaces a
   *  prompt and resumes via a follow-up query() call. Default unset. */
  maxToolCallsBeforeCheckin?: number;
```

- [ ] **Step 5: Add `case 'checkin'` to `mapTerminalToState`**

In `src/tasks/manager.ts`, in the `mapTerminalToState` switch (around line 181), add before `default`:

```typescript
    case 'checkin':
      return 'completed';
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test tests/config/schema.test.ts
bun run typecheck
```

Expected: all 3 new behavior tests PASS; typecheck clean.

- [ ] **Step 7: Run full suite**

```bash
bun test
```

Expected: all tests pass (no regressions).

- [ ] **Step 8: Commit**

```bash
git add src/config/schema.ts src/core/types.ts src/tasks/manager.ts tests/config/schema.test.ts
git commit -m "feat(config): add behavior.maxToolCallsBeforeCheckin setting"
```

---

## Task 2: query.ts checkin logic

**Files:**
- Modify: `src/core/query.ts`
- Test: `tests/core/query.test.ts`

- [ ] **Step 1: Read the test fixture helpers in `tests/core/query.test.ts`**

The file exports `scriptedTurns`, `oneToolThenDoneProvider`, `completedAnswer`, `toolUseAnswer`, and `toolUseThenFinishTurns`. The new tests need a provider that always returns tool_use so the counter accumulates. Use this helper (add to the test file):

```typescript
/** Provider that returns N consecutive tool-use turns then a final completion. */
function nToolTurnsThenDoneProvider(toolTurns: number): LLMProvider {
  let calls = 0;
  return {
    name: 'n-tool-then-done',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      if (calls <= toolTurns) {
        yield { type: 'message_start' };
        yield { type: 'message_stop', stop_reason: 'tool_use' };
        yield { type: 'assistant_message', message: toolUseAnswer };
        return toolUseAnswer;
      }
      for (const ev of completedEvents) yield ev;
      return completedAnswer;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Add this drain helper near the top of `tests/core/query.test.ts` (after the existing `scriptedTurns` / `capturingProvider` helpers):

```typescript
async function drainToTerminal(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<Terminal> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
```

Then add a new `describe` block at the bottom of the file:

```typescript
describe('maxToolCallsBeforeCheckin', () => {
  const echoTool = buildTool({
    name: 'echo',
    description: 'echoes input',
    inputSchema: z.object({ text: z.string() }),
    call: async ({ text }) => ({ text }),
  });

  const toolCtx: ToolContext = {
    sessionId: 'test',
    cwd: '/tmp',
    harnessHome: '/tmp',
  };

  const seed: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];

  test('returns checkin terminal when tool-call count reaches limit', async () => {
    // Provider fires 3 tool-use turns; limit is 2 → checkin fires after turn 2.
    const provider = nToolTurnsThenDoneProvider(3);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [echoTool],
      toolContext: toolCtx,
      maxTokens: 1000,
      maxToolCallsBeforeCheckin: 2,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('checkin');
    expect(terminal.toolCallCount).toBe(2);
  });

  test('does not checkin when limit is not reached', async () => {
    // Provider fires 1 tool-use turn then completes; limit is 5.
    const provider = nToolTurnsThenDoneProvider(1);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [echoTool],
      toolContext: toolCtx,
      maxTokens: 1000,
      maxToolCallsBeforeCheckin: 5,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
  });

  test('without maxToolCallsBeforeCheckin set, never checkins', async () => {
    // Provider fires 5 tool-use turns; no limit set → runs to completion.
    const provider = nToolTurnsThenDoneProvider(5);
    const gen = query({
      provider,
      model: 'test',
      messages: seed,
      systemPrompt: [{ text: 'sys', cacheable: false }],
      tools: [echoTool],
      toolContext: toolCtx,
      maxTokens: 1000,
    });
    const terminal = await drainToTerminal(gen);
    expect(terminal.reason).toBe('completed');
  });
});

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test tests/core/query.test.ts --filter "maxToolCallsBeforeCheckin"
```

Expected: FAIL — `checkin` is returned as `undefined` or `completed`.

- [ ] **Step 4: Add the counter and checkin return to `src/core/query.ts`**

In `src/core/query.ts`, add a counter declaration just after `let loopDetectionCount = 0;` (around line 67):

```typescript
  let totalToolCallCount = 0;
```

Then, inside the `try { for await (const msg of runTools(...)) { ... } ... microcompaction block ... }` block, add the checkin check AFTER the microcompaction block (after line ~422, before the closing `}` of the `try`):

```typescript
      // Backlog item 24 — checkin guard. Accumulate per-turn tool-call count
      // AFTER microcompaction so history is clean before we pause.
      totalToolCallCount += toolUseBlocks.length;
      if (
        params.maxToolCallsBeforeCheckin !== undefined &&
        totalToolCallCount >= params.maxToolCallsBeforeCheckin
      ) {
        return { reason: 'checkin', toolCallCount: totalToolCallCount };
      }
```

The full placement context (so the implementer knows exactly where to add it):

```typescript
      // ... microcompaction block ends here ...
        }
      }
      // Backlog item 24 — checkin guard.
      totalToolCallCount += toolUseBlocks.length;
      if (
        params.maxToolCallsBeforeCheckin !== undefined &&
        totalToolCallCount >= params.maxToolCallsBeforeCheckin
      ) {
        return { reason: 'checkin', toolCallCount: totalToolCallCount };
      }
    } catch (err) {
      // ... existing error handling ...
    }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/core/query.test.ts --filter "maxToolCallsBeforeCheckin"
```

Expected: all 3 checkin tests PASS.

- [ ] **Step 6: Run full suite + typecheck**

```bash
bun run typecheck && bun test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/query.ts tests/core/query.test.ts
git commit -m "feat(query): return 'checkin' terminal when per-turn tool-call limit is reached"
```

---

## Task 3: /continue slash command

**Files:**
- Modify: `src/commands/types.ts`
- Modify: `src/commands/registry.ts`
- Create: `tests/commands/continue.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/continue.test.ts`:

```typescript
// Unit tests for the /continue slash command. Tests the command handler's
// behavior when resumeCheckin is and is not available on CommandContext.

import { describe, expect, mock, test } from 'bun:test';
import { COMMANDS } from '../../src/commands/registry.js';
import type { CommandContext } from '../../src/commands/types.js';

function findContinueCommand() {
  const cmd = COMMANDS.find((c) => c.name === 'continue');
  if (!cmd || cmd.type !== 'local') throw new Error('/continue not found as local command');
  return cmd;
}

function stubContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'test',
    cwd: '/tmp',
    providerName: 'fake',
    model: 'test-model',
    bundlePath: null,
    setModel: () => {},
    clearHistory: () => '',
    getCost: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCostUsd: 0,
      estimatedCompactionCostUsd: 0,
    }),
    compact: async () => ({
      parentSessionId: 'p',
      newSessionId: 'n',
      compactedMessages: 0,
      estimatedBeforeTokens: 0,
      estimatedAfterTokens: 0,
    }),
    rollback: async () => 'rolled back',
    tools: [],
    registry: new Map(),
    listSessions: () => [],
    getMetrics: () => ({
      sessionId: 'test',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCostUsd: 0,
      estimatedCompactionCostUsd: 0,
      toolCalls: 0,
      toolErr: 0,
      toolTimeMs: 0,
      userTurns: 0,
    }),
    skills: { list: () => [] } as unknown as import('../../src/skills/types.js').SkillRegistry,
    getLastAssistantText: () => null,
    getMessages: () => [],
    getPermissions: () => ({ mode: 'default' as const, alwaysAllow: [], layers: [] }),
    requestExit: () => {},
    getBudgetReport: () => ({ components: [], totals: { estimated: 0 } }),
    expandToolBlock: () => ({ ok: false, total: 0 }),
    ...overrides,
  } as unknown as CommandContext;
}

describe('/continue command', () => {
  test('returns "no pending checkin" when resumeCheckin is undefined', async () => {
    const cmd = findContinueCommand();
    const ctx = stubContext({ resumeCheckin: undefined });
    const output = await cmd.call('', ctx);
    expect(output).toContain('no pending checkin');
  });

  test('calls resumeCheckin and returns empty string when checkin is pending', async () => {
    const cmd = findContinueCommand();
    let resumed = false;
    const ctx = stubContext({
      resumeCheckin: async () => {
        resumed = true;
      },
    });
    const output = await cmd.call('', ctx);
    expect(resumed).toBe(true);
    expect(output).toBe('');
  });

  test('/continue is registered in COMMANDS array', () => {
    const cmd = COMMANDS.find((c) => c.name === 'continue');
    expect(cmd).toBeDefined();
    expect(cmd?.type).toBe('local');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/commands/continue.test.ts
```

Expected: FAIL — `continue` command not found.

- [ ] **Step 3: Add `resumeCheckin?` to `CommandContext`**

In `src/commands/types.ts`, add after the existing `expandToolBlock` field (around line 76):

```typescript
  /** Set by the REPL when a turn is paused at the tool-call checkin limit.
   *  Calling it clears the pending flag and resumes the model turn.
   *  Undefined when no checkin is pending. */
  resumeCheckin?: () => Promise<void>;
```

- [ ] **Step 4: Register `/continue` in `src/commands/registry.ts`**

In `COMMAND_CATEGORIES` (around line 28), add:

```typescript
  continue: 'session',
```

In `COMMANDS` array (after the existing `compact`/`rollback` commands, around line 103), add:

```typescript
  {
    type: 'local',
    name: 'continue',
    description: 'Resume a turn paused by the tool-call checkin limit.',
    call: async (_args, ctx) => {
      if (!ctx.resumeCheckin) return 'no pending checkin';
      await ctx.resumeCheckin();
      return '';
    },
  },
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/commands/continue.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 6: Run full suite + typecheck**

```bash
bun run typecheck && bun test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/types.ts src/commands/registry.ts tests/commands/continue.test.ts
git commit -m "feat(commands): add /continue slash command for post-checkin resume"
```

---

## Task 4: REPL wiring

**Files:**
- Modify: `src/ui/terminalRepl.ts`

This task wires four things together:
1. `checkinPending` state variable
2. Pass `maxToolCallsBeforeCheckin` from settings into `query()`
3. Handle the `'checkin'` terminal reason
4. `isContinuation` flag in `runModelTurn` + `resumeCheckin` in `commandContext()`

There are no easy unit tests for the full REPL. Verify via typecheck + full test suite, then do a brief manual smoke test.

- [ ] **Step 1: Add `checkinPending` state variable**

In `src/ui/terminalRepl.ts`, locate the block of REPL-scoped state variables. A good landmark is near `let lastTerminal: Terminal | undefined;` around line 1130. Add nearby (search for `let lastTerminal`):

```typescript
    let checkinPending = false;
```

Place it alongside the other session-scoped `let` declarations (e.g. near `let lastTerminal`, `let activeModel`, etc.).

- [ ] **Step 2: Add `isContinuation` flag to `runModelTurn`**

Find the `runModelTurn` function signature (around line 1269):

```typescript
async function runModelTurn(
  userContent: Message['content'],
  command?: PromptCommand,
  retry: { skipUserSave?: boolean; retriedAfterCompact?: boolean } = {},
): Promise<void> {
```

Change to:

```typescript
async function runModelTurn(
  userContent: Message['content'],
  command?: PromptCommand,
  retry: { skipUserSave?: boolean; retriedAfterCompact?: boolean; isContinuation?: boolean } = {},
): Promise<void> {
```

Then find the guard at line 1274:

```typescript
      if (retry.skipUserSave !== true) {
        const userMessage: Message = { role: 'user', content: userContent };
        history.push(userMessage);
        db.saveMessage(activeSessionId, {
          role: 'user',
          content: userMessage.content,
          tokenCount: estimateMessageTokens(userMessage),
        });
      }
```

Change to:

```typescript
      if (retry.skipUserSave !== true && retry.isContinuation !== true) {
        const userMessage: Message = { role: 'user', content: userContent };
        history.push(userMessage);
        db.saveMessage(activeSessionId, {
          role: 'user',
          content: userMessage.content,
          tokenCount: estimateMessageTokens(userMessage),
        });
      }
```

- [ ] **Step 3: Pass `maxToolCallsBeforeCheckin` to `query()`**

Find the `query({...})` call inside `runModelTurn` (around line 1369). It currently has:

```typescript
          ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
```

Add the new field immediately after:

```typescript
          ...(userSettings.behavior?.maxToolCallsBeforeCheckin !== undefined
            ? { maxToolCallsBeforeCheckin: userSettings.behavior.maxToolCallsBeforeCheckin }
            : {}),
```

- [ ] **Step 4: Handle the `'checkin'` terminal in the terminal-processing block**

Find the existing terminal-processing block (around line 1622):

```typescript
      if (terminal?.reason === 'error') {
        ...
      } else if (terminal?.reason === 'interrupted') {
        ...
      } else if (terminal?.reason === 'max_tokens') {
        ...
      } else if (terminal?.reason === 'max_turns') {
        writeStatusLine(chalk.yellow('[max turns reached]'), 'err');
      }
```

Add a new branch at the end:

```typescript
      } else if (terminal?.reason === 'checkin') {
        const count = terminal.toolCallCount ?? 0;
        process.stderr.write(
          chalk.yellow(
            `\n[checkin] ${count} tool call${count === 1 ? '' : 's'} — type /continue to keep going, or send a new message.\n`,
          ),
        );
        checkinPending = true;
      }
```

- [ ] **Step 5: Wire `resumeCheckin` in `commandContext()`**

Find `commandContext()` (around line 1067). It returns a large object. Add `resumeCheckin` at the end of the object, just before the closing `})`:

```typescript
      resumeCheckin: checkinPending
        ? async () => {
            checkinPending = false;
            reviewManager?.onUserTurn(activeSessionId);
            await runModelTurn([], undefined, { isContinuation: true });
          }
        : undefined,
```

- [ ] **Step 6: Suppress the double-newline when `/continue` returns `''`**

Find the slash-command dispatch block (around line 1238):

```typescript
        if (result.kind === 'local' || result.kind === 'unknown') {
          transcript?.record({
            type: 'slash_command',
            sessionId: activeSessionId,
            command: trimmed,
            kind: result.kind,
            output: result.output,
          });
          process.stdout.write('\n');
          process.stdout.write(`${result.output}\n`);
          continue;
        }
```

Change the two stdout writes to:

```typescript
          process.stdout.write('\n');
          if (result.output) process.stdout.write(`${result.output}\n`);
```

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```

Expected: clean. If there are issues, they will be around `terminal.toolCallCount` (possibly needs narrowing) or the new `resumeCheckin` type. Fix any type errors before proceeding.

Common fix needed: when accessing `terminal.toolCallCount` in the REPL, TypeScript may not know `reason === 'checkin'` narrows to that field since `Terminal` is a flat type. Add a cast or use `(terminal as { toolCallCount?: number }).toolCallCount` if needed.

- [ ] **Step 8: Run full suite**

```bash
bun test
```

Expected: all 1769+ tests pass (no regressions).

- [ ] **Step 9: Manual smoke test**

```bash
# Create a test session that hits the checkin limit
sov chat
```

At the prompt, run a message that triggers ≥ 2 tool calls. First configure the limit:

```bash
# In a separate terminal, temporarily set the limit:
harness config set behavior.maxToolCallsBeforeCheckin 2
```

Then in sov chat, type a prompt that will use multiple tools (e.g. "List the files in /tmp and also tell me the current date"). After 2 tool calls, you should see:

```
[checkin] 2 tool calls — type /continue to keep going, or send a new message.
```

Type `/continue` — the model should resume and finish.

After the test, unset the limit:

```bash
harness config unset behavior.maxToolCallsBeforeCheckin
```

- [ ] **Step 10: Commit**

```bash
git add src/ui/terminalRepl.ts
git commit -m "feat(repl): wire checkin lifecycle — pass limit, handle terminal, wire /continue"
```

---

## Post-implementation

After all 4 tasks are complete:

- [ ] Run the full test suite one final time: `bun test` — 1769+ tests pass
- [ ] Run `bun run typecheck` and `bun run lint` — both clean
- [ ] Update `docs/post-phase-13-4-backlog.md`: change item 24's Status from `open (discussion)` to `complete (YYYY-MM-DD, commits <sha1>...<sha4>)` with a brief summary
