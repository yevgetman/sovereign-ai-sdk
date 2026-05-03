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

## Update Documentation

When a change introduces a non-trivial design choice, add an entry to `DECISIONS.md`. When user-facing behavior changes, update the README or the relevant file under `docs/`. Phase-completion notes belong in `CHANGELOG.md`.
