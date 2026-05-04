# Extending The Runtime

This guide covers common code changes. Keep changes narrow, preserve the async-generator turn loop, and prefer existing contracts over one-off paths.

## Add A Native Tool

1. Create `src/tools/MyTool.ts` with a one-responsibility header comment.
2. Define input and output schemas with Zod.
3. Export a tool built with `buildTool()`.
4. Implement `call(input, ctx, onProgress?)`.
5. Add `renderResult()` when structured output needs a user-facing transcript shape.
6. Add `preparePermissionMatcher()` if permission rules should support tool-specific patterns.
7. Add `virtualToolName(input)` if the tool's operations map to another tool's permission rules (e.g., a shell wrapper that does reads should return `'Read'`).
8. Add `affectedPaths()`, `isReadOnly(input)`, and `isConcurrencySafe(input)` only when they are true for the actual invocation.
8. Register the tool in `assembleToolPool()` in `src/tool/registry.ts`.
9. Add focused tests under `tests/tools/` and orchestration tests if concurrency or path behavior matters.

Skeleton:

```ts
// MyTool - one sentence naming the tool responsibility.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const Input = z.object({
  path: z.string(),
});

const Output = z.object({
  ok: z.boolean(),
});

export const MyTool = buildTool({
  name: 'MyTool',
  description: () => 'Short tool description for the model.',
  inputSchema: Input,
  outputSchema: Output,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  affectedPaths: (input) => [input.path],
  async call(input, ctx) {
    return { data: { ok: true } };
  },
  renderResult(output) {
    return { content: JSON.stringify(output) };
  },
});
```

Do not register ad hoc tool objects. Every tool goes through `buildTool()` so default permission, concurrency, and interruption behavior stay fail-closed.

## Add A Provider

1. Add the provider metadata to `src/providers/models.ts`.
2. Implement a provider adapter in `src/providers/<name>.ts`.
3. Implement `LLMProvider.stream(req)` and translate provider events into internal `StreamEvent`s.
4. Keep SDK calls inside `src/providers/`.
5. Normalize all assistant output into internal content blocks.
6. Add resolver support in `src/providers/resolver.ts`.
7. Add pricing data in `src/providers/pricing.ts` if `/cost` should estimate usage.
8. Add tests under `tests/providers/` using fixture chunks where practical.

The core runtime should not know provider-specific message shapes. If a change requires editing `src/core/query.ts` for a provider quirk, isolate the quirk in the provider adapter instead.

## Add A Slash Command

1. Add a command object. New commands typically live in one of the topic-specific files: `src/commands/info.ts` for read-only info commands, `pickers.ts` for commands that need the raw-mode picker, `sessionOps.ts` for file/session-shaping commands. The aggregate registry in `src/commands/registry.ts` spreads these arrays.
2. Choose the command kind:
   - `local` for immediate local output.
   - `prompt` for commands that feed a model turn.
   - `local-jsx` for future rendered local UI.
3. Add `usage` when arguments are expected.
4. For prompt commands, set `allowedTools` to the narrowest useful tool scope.
5. If the command needs picker UI, import `pick` from `src/ui/picker.js`. The picker takes over the screen, runs ↑/↓/Enter/Esc, and returns `Promise<T | null>`. Always include a non-TTY fallback (returns null on non-TTY automatically; print a hint to the user).
6. Add the command name to `COMMAND_CATEGORIES` in `registry.ts` so it appears in the right `/help` section.
7. Add tests in `tests/commands/`. The shared `tests/commands/_makeCtx.ts` helper builds a `CommandContext` stub with sensible defaults — override only the fields your test cares about.

Prompt commands are still normal model turns. They should constrain tools through `allowedTools` rather than creating custom execution paths.

### Render output with theme tokens

Slash command output that uses color should consume `theme.tokens.<role>(...)` from `src/ui/theme.js` instead of literal `chalk.<color>(...)`. That way the user's chosen theme (`dark` / `light` / `no-color`) flows through. Available roles include `text`, `textMuted`, `textBold`, `accent`, `statusSuccess`, `statusWarning`, `statusError`, `diffAdded`, `diffRemoved`, `border`, `codeInline`. See `src/ui/theme.ts` for the full set.

## Add Or Change Permission Rules

Permission parsing and wildcard matching live in `src/config/rules.ts`; orchestration-level permission decisions live in `src/permissions/canUseTool.ts`.

When a rule needs tool-specific semantics, add or update the tool's `preparePermissionMatcher()` instead of teaching the global rule engine about that tool's input shape.

### Virtual Tool Mapping

Tools can implement `virtualToolName(input)` to map their input to a different tool name for permission resolution. The permission evaluator checks rules for both the actual tool name and the virtual name. This lets `Bash("cat src/main.ts")` resolve against `Read` rules.

To add a new command to the shell analyzer, add it to the appropriate set in `src/permissions/shellSemantics.ts`: `READ_COMMANDS`, `WRITE_COMMANDS`, `EDIT_COMMANDS`, or `WEB_COMMANDS`. For commands with flag-dependent behavior (like `sed -i`), add a handler in `analyzeSegment()`.

### Permission Invariants

Preserve these invariants:

- deny wins within a settings layer
- local project settings outrank user settings
- `ask` can force a prompt even when fallthrough would allow
- `updatedInput` must be validated again before execution
- permission prompts deny by default on empty input
- virtual tool name resolution is fail-closed: if `virtualToolName()` throws, no virtual rules apply

## Add A Skill Capability

Skills are markdown files loaded by `src/skills/loader.ts`. Runtime-visible skill behavior is split across:

- `src/skills/types.ts` for the registry shape
- `src/skills/visibility.ts` for active-tool and active-toolset gates
- `src/skills/guard.ts` for trust-tier scanning
- `src/tools/SkillsListTool.ts` and `src/tools/SkillsViewTool.ts` for progressive disclosure
- `src/tools/SkillTool.ts` and `src/skills/commands.ts` for invocation

New skill features should preserve progressive disclosure: the system prompt should carry a reminder, not the full skill body.

## Add A Session Migration

1. Increment `CURRENT_SCHEMA_VERSION` in `src/agent/sessionDb.ts`.
2. Add a `Migration` entry from the previous version to the new version.
3. Keep migrations forward-only.
4. Update types such as `Session` and `SessionCost`.
5. Update create/read/write SQL.
6. Add migration tests in `tests/agent/sessionDb.test.ts`.

Use additive schema changes where possible. Existing local databases are part of the developer experience, so migrations should be boring and deterministic.

## Add A Context Surface

Context that should remain stable for a session belongs in system prompt assembly under `src/context/`. Context that depends on the current user turn belongs in user-message expansion or injection.

Do not mutate the frozen system prompt after session creation. On resume, the stored system prompt wins.

Injection-prone external text should be fenced, labeled, bounded, and screened before it reaches the model.

## Add A Semantic Test

Semantic tests live under `tests/semantic/suites/*.cases.ts`. Each one is a single prompt (or array of prompts for multi-turn cases) + judge criteria designed to weed out a specific bug class. See [`docs/semantic-testing.md`](./semantic-testing.md) for the full inventory of existing tests, what each guards against, and the policy for when to add a new one (new tool / slash command / permission rule path / context surface, or a bug that should never regress).

1. Open or create `tests/semantic/suites/NN-topic.cases.ts`.
2. Append an entry to its exported `tests: SemanticTest[]`:

```ts
{
  id: 'kebab-case-id',           // unique across the whole suite
  name: 'Short human title',
  description: 'Which bug class does this test guard against?',
  category: 'tools' | 'commands' | 'permissions' | 'context' | 'workflow' | 'refusal',
  setup: { files: [{ path: 'foo.txt', content: 'bar' }] }, // optional
  // Single string for one turn, or string[] for multi-turn (one prompt per turn).
  prompt: 'The single user prompt sent to the agent.',
  judgeCriteria: {
    mustSatisfy: [
      'A behavior the transcript MUST demonstrate.',
    ],
    shouldNot: [
      'A behavior that, if observed, forces fail.',
    ],
  },
  timeoutMs: 45_000,             // optional; default 60_000; bump for multi-turn (90-180s)
  binaryArgs: ['--permission-mode', 'default'],  // optional; overrides driver defaults
}
```

3. Validate with `bun run test:semantic -- --filter <your-id>`.

Design rules:

- One target bug class per test. Don't try to verify five things at once — multiple weakly-related criteria make the verdict harder to interpret.
- Criteria must be observable in the ANSI-stripped transcript. "The agent invoked the Read tool" is observable; "the agent understood the intent" is not.
- Embed unique tokens (`sovereign-test-token-9f3e1c`) in echo-style prompts so the judge can tell genuine tool output from fabrication.
- Always include a `shouldNot` to catch hallucination bugs that a presence-only check would miss.
- Setups must be deterministic: declare every input file in `setup.files`, never depend on ambient state.
- Pick prompts the agent has no independent reason to refuse. Modern models refuse risky commands like `rm` on their own safety judgment, masking the system you're actually trying to test (e.g., the permission deny rule). Use innocuous targets like `echo` and rely on the test setup to gate them.
- For multi-turn cases, criteria can refer to specific turns ("In Turn 2, the agent..."). The judge prompt builder formats multi-turn prompts as numbered turns automatically.

### Add A Judge Backend

`Judge` is a function type. Adding `codex`, an OpenAI judge, or eventually `sov`-judges-itself is mechanical:

1. Create `tests/semantic/framework/judges/<name>.ts`. Export `create<Name>Judge(opts)` returning `Judge`. Use `buildJudgePrompt()` from `prompt.ts` for the prompt and either `parseVerdictFromText()` or `makeVerdict()` for the verdict shape.
2. Wire it into `framework/judges/index.ts`: add to the `JudgeBackendName` union and a case to `selectJudge()`.
3. Document the backend in the table in `tests/semantic/README.md` and add coverage notes to [`docs/semantic-testing.md`](./semantic-testing.md) if relevant.

The runner, the entry point, and every test case stay unchanged.

## Update Documentation

When a change introduces a non-trivial design choice, add an entry to `DECISIONS.md`. When user-facing behavior changes, update the README or the relevant file under `docs/`. Phase-completion notes belong in `CHANGELOG.md`.
