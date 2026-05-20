# Phase 16.1 M13 — terminalRepl removal implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `src/ui/terminalRepl.ts` (2334 LoC) + 9 REPL-only ui modules + the M12 deprecation infrastructure + the M11 surface resolver. Collapse the main.ts boot flow to a single TUI launch path with hard-error on missing binary. Drop `--ui` flag, `SOV_UI` env, `ui.surface` config field.

**Architecture:** Strictly removal + simplification. Locked by [M13 design spec](../specs/2026-05-19-phase-16-1-m13-terminalrepl-removal-design.md). Four ADRs (M13-01..04) drive the changes — hard error on missing binary, drop `ui.surface` field, drop `--ui` + `SOV_UI`, delete surface resolver.

**Tech Stack:** TypeScript / Bun. Existing lint + typecheck + test gate (`bun run lint && bun run typecheck && bun run test`). No new dependencies.

**Pre-flight (do once at session start):**
- Read [M13 spec](../specs/2026-05-19-phase-16-1-m13-terminalrepl-removal-design.md).
- Confirm baseline green: `cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test`. Expect 2085 pass / 0 fail / 14 skip.
- Confirm clean working tree: `git status` returns clean.

**Commit cadence:** One commit per task. Each task ends with the same gate (lint + typecheck + test all green). Push autonomously after each task per the repo's atomic-commits convention.

---

### Task 1: Rewire main.ts boot flow

**Goal:** Collapse the 65-line surface-resolution + REPL-fallback + REPL-launch block into ~15 lines that go straight to the TUI (or hard error). Drop `--ui` option and `--legacy-input` option.

**Files:**
- Modify: `src/main.ts:181-272`

- [ ] **Step 1: Edit `src/main.ts:181-198` — drop `--ui` and `--legacy-input` options.**

Remove these lines:
```ts
    .option('--legacy-input', 'use the readline-based input (Wave-3 fallback for the new editor)')
    .option('--ui <surface>', 'foreground surface: tui (default) or repl')
```

The surrounding options stay. Result: `--transcript`, `-v/--verbose` flow directly into `--capture-fixture`.

- [ ] **Step 2: Edit `src/main.ts:199-272` — replace the action body.**

Replace the entire `.action(async (opts) => { ... })` block with:

```ts
    .action(async (opts) => {
      // Deprecation notice — fired only when 'chat' is explicitly typed, not
      // when the bare `sov` invocation triggers Commander's default action.
      if (process.argv[2] === 'chat') {
        process.stderr.write(
          "[deprecated] 'sov chat' is going away — use bare 'sov' for the interactive REPL, or 'sov dispatch' for headless slash-command testing.\n",
        );
      }

      const { findTuiBinary, runTuiLauncher } = await import('./cli/tuiLauncher.js');
      if (findTuiBinary() === null) {
        process.stderr.write('sov: sov-tui binary not found. Install with:\n');
        process.stderr.write('     bun pm -g trust @yevgetman/sov && sov upgrade\n');
        process.exit(1);
      }

      const code = await runTuiLauncher(opts);
      process.exit(code);
    });
```

- [ ] **Step 3: Verify `readConfig` and `resolveBundlePath` imports still needed.**

Both were used inside the deleted block. Check whether anything else in main.ts uses them. Run:
```bash
grep -n "readConfig\|resolveBundlePath" /Users/julie/code/sovereign-ai-harness/src/main.ts
```
If unused, remove the imports at the top of `main.ts`. The Commander tooling around the `dispatch` subcommand and other top-level config may still use them — confirm.

- [ ] **Step 4: Run gate.**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test
```

Expected: typecheck may still pass even if `surfaceResolver.ts` / `replDeprecation.ts` still exist (they're now orphaned but valid). Tests may have a few failures referencing the removed `--ui` flag — note them, they'll be fixed in T4/T11.

- [ ] **Step 5: Commit.**

```bash
git add src/main.ts && git commit -m "$(cat <<'EOF'
refactor(cli): collapse main.ts boot flow to single TUI launch (M13 T1)

Drop --ui flag, --legacy-input flag, surface-resolver call, M12
deprecation warning emit, and REPL-fallback path. With the readline
REPL going away in subsequent M13 tasks, bare sov now boots the Go
TUI or hard-errors on missing binary.

Part of M13 (terminalRepl removal). ADRs M13-01, M13-03.
EOF
)"
```

---

### Task 2: Delete `src/ui/terminalRepl.ts`

**Goal:** Delete the 2334-line REPL implementation. With T1's rewire, nothing imports it.

**Files:**
- Delete: `src/ui/terminalRepl.ts`

- [ ] **Step 1: Confirm zero importers.**

```bash
grep -rn "from .*terminalRepl\|require.*terminalRepl" /Users/julie/code/sovereign-ai-harness/src /Users/julie/code/sovereign-ai-harness/tests 2>/dev/null
```

Expected output: comment-only references (none using `import`/`require`). If any actual import exists, stop and investigate.

- [ ] **Step 2: Delete the file.**

```bash
rm /Users/julie/code/sovereign-ai-harness/src/ui/terminalRepl.ts
```

- [ ] **Step 3: Run gate.**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test
```

Expected: typecheck clean. Test count drops slightly (semantic suite cases referencing terminalRepl may exist — investigate any failures). Test failures in `tests/cli/replDeprecation.test.ts` or similar may surface — those tests die in subsequent tasks.

If typecheck flags unused imports elsewhere (`createClearedChildSession`, `loadAgents`, etc. that were also used by terminalRepl but are exported and used elsewhere), they should remain — typecheck flags only unused imports inside a single file, and those modules are imported in multiple places.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor(ui): delete terminalRepl.ts (M13 T2)

The readline REPL surface is removed. Bare sov now boots the Go TUI
via runTuiLauncher; the REPL has no callers after M13 T1.

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 3: Delete `src/cli/replDeprecation.ts` + test

**Goal:** Delete the M12 deprecation warning helper and its test. With T1's rewire, the helper has no callers.

**Files:**
- Delete: `src/cli/replDeprecation.ts`
- Delete: `tests/cli/replDeprecation.test.ts`

- [ ] **Step 1: Confirm zero importers.**

```bash
grep -rn "replDeprecation" /Users/julie/code/sovereign-ai-harness/src /Users/julie/code/sovereign-ai-harness/tests 2>/dev/null
```

Expected: matches inside the two files themselves only (their docstrings + the test's imports of the module-under-test).

- [ ] **Step 2: Delete both files.**

```bash
rm /Users/julie/code/sovereign-ai-harness/src/cli/replDeprecation.ts /Users/julie/code/sovereign-ai-harness/tests/cli/replDeprecation.test.ts
```

- [ ] **Step 3: Run gate.**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count drops by ~7 (the replDeprecation suite).

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor(cli): delete replDeprecation helper + test (M13 T3)

The M12 readline-REPL deprecation warning was self-cancelling — once
M13 removes the REPL surface, there's nothing to deprecate. Helper +
test deleted.

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 4: Delete `src/cli/surfaceResolver.ts` + test

**Goal:** Delete the M11 foreground-surface resolver. With T1's rewire (and only one valid surface), the resolver is dead code.

**Files:**
- Delete: `src/cli/surfaceResolver.ts`
- Delete: `tests/cli/surfaceResolver.test.ts`

- [ ] **Step 1: Confirm zero non-test importers.**

```bash
grep -rn "surfaceResolver\|resolveSurface\|SurfaceResolution\|SurfaceSource\b" /Users/julie/code/sovereign-ai-harness/src /Users/julie/code/sovereign-ai-harness/tests 2>/dev/null
```

Expected: matches in `surfaceResolver.ts` and its test only. If anything else (e.g. `replDeprecation.ts` importing `SurfaceSource`) shows up, it should have been removed in T3 — investigate.

- [ ] **Step 2: Delete both files.**

```bash
rm /Users/julie/code/sovereign-ai-harness/src/cli/surfaceResolver.ts /Users/julie/code/sovereign-ai-harness/tests/cli/surfaceResolver.test.ts
```

- [ ] **Step 3: Run gate.**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count drops by ~13.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor(cli): delete surfaceResolver + test (M13 T4)

Resolver returned 'tui' | 'repl' with CLI > env > config > default
precedence. With one valid surface left, there's nothing to resolve.

Part of M13 (terminalRepl removal). ADR M13-04.
EOF
)"
```

---

### Task 5: Trim `src/permissions/prompt.ts`

**Goal:** Remove `buildReadlineAsker` + `parseAskResponse` + their readline/modal dependencies. Keep `serializeAskUser` + `previewToolInput` (live consumers in `canUseTool.ts`).

**Files:**
- Modify: `src/permissions/prompt.ts`
- Modify: `tests/permissions/prompt.test.ts`

- [ ] **Step 1: Read the current `src/permissions/prompt.ts` to confirm the surface to trim.**

Re-confirm: `parseAskResponse` (lines 32-38), `buildReadlineAsker` (lines 44-79). Plus imports: `readline/promises` (line 11), `chalk` (line 12), `ModalRow`/`withModal` from `../ui/modal.js` (line 13). Plus the `ReadlineQuestion` type (line 16).

- [ ] **Step 2: Edit `src/permissions/prompt.ts` — replace the file content with:**

```ts
// Permission prompt utilities — askUser serializer + tool-input preview.
//
// After M13 dropped the readline REPL surface, the readline-based asker is
// gone; the surviving exports are consumed by canUseTool.ts.

import type { AskResponse, AskUser } from './types.js';

/** Serialize interactive permission prompts so concurrent tool batches do
 * not print multiple readline questions at once. Tool execution can still
 * run concurrently after each permission decision resolves. */
export function serializeAskUser(ask: AskUser): AskUser {
  let tail: Promise<void> = Promise.resolve();
  return async (opts) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (opts.signal?.aborted) throw new Error('permission prompt aborted');
      return await ask(opts);
    } finally {
      release();
    }
  };
}

/** Truncated single-line preview of a tool_use input. Shared shape with the
 * server's inline hint but kept separate to avoid cross-module coupling; if
 * a third caller appears, graduate to src/tool/preview.ts. */
export function previewToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncate(input);
  if (typeof input !== 'object') return truncate(String(input));
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return truncate(obj.command);
  try {
    return truncate(JSON.stringify(obj));
  } catch {
    return '';
  }
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}
```

The unused `AskResponse` import comes off too — only `AskUser` is used.

- [ ] **Step 3: Update `tests/permissions/prompt.test.ts` — remove tests for deleted exports.**

Open the file. Delete:
- The `parseAskResponse` import.
- The `buildReadlineAsker` import.
- Any `describe('parseAskResponse', ...)` block.
- The `describe('buildReadlineAsker', ...)` block.

Keep tests for `serializeAskUser` and `previewToolInput` if they exist. If the only remaining content is imports + a `describe('serializeAskUser', ...)` and/or `describe('previewToolInput', ...)`, that's the new file content.

- [ ] **Step 4: Run gate.**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count drops by ~5–10 (parseAskResponse + buildReadlineAsker cases).

- [ ] **Step 5: Commit.**

```bash
git add src/permissions/prompt.ts tests/permissions/prompt.test.ts && git commit -m "$(cat <<'EOF'
refactor(permissions): drop readline asker from prompt.ts (M13 T5)

After M13 dropped the readline REPL surface, buildReadlineAsker and
parseAskResponse have no callers. Surviving exports (serializeAskUser,
previewToolInput) are kept — canUseTool.ts still uses them.

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 6: Delete 9 orphan `src/ui/*.ts` modules + their tests

**Goal:** Delete the 9 REPL-only ui modules confirmed orphan by the spec §4.2 importer audit.

**Files (delete all 18):**
- Delete: `src/ui/bracketedPaste.ts` + `tests/ui/bracketedPaste.test.ts`
- Delete: `src/ui/inlineShell.ts` + `tests/ui/inlineShell.test.ts`
- Delete: `src/ui/inputEditor.ts` + `tests/ui/inputEditor.test.ts`
- Delete: `src/ui/markdownStream.ts` + `tests/ui/markdownStream.test.ts`
- Delete: `src/ui/queuedQuestion.ts` + `tests/ui/queuedQuestion.test.ts`
- Delete: `src/ui/terminalMessages.ts` + `tests/ui/terminalMessages.test.ts`
- Delete: `src/ui/thinking.ts` + `tests/ui/thinking.test.ts`
- Delete: `src/ui/toolSlot.ts` + `tests/ui/toolSlot.test.ts`
- Delete: `src/ui/transcript.ts` + `tests/ui/transcript.test.ts`

- [ ] **Step 1: Re-confirm each module is orphan (post-T2 delete).**

```bash
cd /Users/julie/code/sovereign-ai-harness
for name in bracketedPaste inlineShell inputEditor markdownStream queuedQuestion terminalMessages thinking toolSlot transcript; do
  hits=$(grep -rlE "from ['\"](\\./|.*ui/)${name}(\\.js)?['\"]" src tests scripts 2>/dev/null | grep -v "^src/ui/${name}.ts$" | grep -v "^tests/ui/${name}.test.ts$")
  if [ -n "$hits" ]; then echo "STOP — $name still imported by: $hits"; fi
done
echo "(silence = all clear)"
```

Expected: silence. If any imports remain, terminalRepl removal in T2 must have missed something — investigate before continuing.

- [ ] **Step 2: Delete all 18 files in one batch.**

```bash
cd /Users/julie/code/sovereign-ai-harness
rm src/ui/bracketedPaste.ts tests/ui/bracketedPaste.test.ts
rm src/ui/inlineShell.ts tests/ui/inlineShell.test.ts
rm src/ui/inputEditor.ts tests/ui/inputEditor.test.ts
rm src/ui/markdownStream.ts tests/ui/markdownStream.test.ts
rm src/ui/queuedQuestion.ts tests/ui/queuedQuestion.test.ts
rm src/ui/terminalMessages.ts tests/ui/terminalMessages.test.ts
rm src/ui/thinking.ts tests/ui/thinking.test.ts
rm src/ui/toolSlot.ts tests/ui/toolSlot.test.ts
rm src/ui/transcript.ts tests/ui/transcript.test.ts
```

- [ ] **Step 3: Run gate.**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count drops by ~50 (9 modules × ~5 tests each on average).

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor(ui): delete 9 orphan REPL-only modules + tests (M13 T6)

bracketedPaste, inlineShell, inputEditor, markdownStream,
queuedQuestion, terminalMessages, thinking, toolSlot, transcript.
Each was REPL-coupled with no other production consumer (test was
the only non-REPL importer).

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 7: Remove `ui.surface` from config schema + update test

**Goal:** Per ADR M13-02, drop the `surface` field from `UiSchema`. The broader `ui` object stays.

**Files:**
- Modify: `src/config/schema.ts:104-107` (the `surface` field within `UiSchema`)
- Modify: `tests/config/schema.test.ts:78-83` (the `ui.surface` validation cases)

- [ ] **Step 1: Read `src/config/schema.ts` around line 100-115 to confirm field location.**

The `UiSchema` Zod object contains the `surface` field at lines ~104-107:
```ts
    /** Foreground surface for bare `sov` (M11). Resolved at boot via
     *  CLI --ui flag > env SOV_UI > config ui.surface > 'tui' default.
     *  Set with `sov config set ui.surface tui|repl` or clear with
     *  `sov config unset ui.surface`. */
    surface: z.enum(['tui', 'repl']).optional(),
```

- [ ] **Step 2: Delete that field block from `src/config/schema.ts`.**

Use Edit to remove the 4-line JSDoc + the field definition. The surrounding `UiSchema` object remains.

- [ ] **Step 3: Update `tests/config/schema.test.ts:78-83`.**

Read lines 75-85 to confirm the test block. It looks like:
```ts
  test('ui.surface accepts "tui" and "repl"', () => {
    for (const surface of ['tui', 'repl'] as const) {
      expect(() => SettingsSchema.parse({ ui: { surface } })).not.toThrow();
    }
    expect(() => SettingsSchema.parse({ ui: { surface: 'web' } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { surface: 123 } })).toThrow();
  });
```

Replace with a single negative case:
```ts
  test('ui.surface is no longer accepted (M13)', () => {
    expect(() => SettingsSchema.parse({ ui: { surface: 'tui' } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { surface: 'repl' } })).toThrow();
  });
```

Note: this relies on `UiSchema` being `.strict()` (rejects unknown fields). Verify by reading the schema's mode. If `UiSchema` uses `.passthrough()` instead, the test must be removed entirely since unknown fields will be silently accepted.

- [ ] **Step 4: Run gate.**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count net-neutral (one case replaced).

- [ ] **Step 5: Commit.**

```bash
git add src/config/schema.ts tests/config/schema.test.ts && git commit -m "$(cat <<'EOF'
refactor(config): drop ui.surface field from schema (M13 T7)

With the readline REPL gone, there's one valid surface and the field
carries no information. Existing configs with ui.surface set now fail
schema validation per .strict() mode.

Part of M13 (terminalRepl removal). ADR M13-02.
EOF
)"
```

---

### Task 8: Update `src/cli/tuiLauncher.ts` — drop REPL-fallback references

**Goal:** Remove the dead `--legacy-input` rejection block and the stale REPL-fallback hint in the binary-missing warning. main.ts now hard-errors before reaching the launcher's defensive guard, but the defensive guard should still produce sensible output if invoked directly.

**Files:**
- Modify: `src/cli/tuiLauncher.ts`

- [ ] **Step 1: Read `src/cli/tuiLauncher.ts:100-155` to confirm the surface.**

Three areas:
1. The `legacyInput?: unknown;` field in `TuiLaunchOptions` (~line 102) + the surrounding "REPL-only" comment (~line 100-101).
2. The `if (opts.legacyInput === true) {...}` rejection block (~lines 142-151).
3. The "For the readline REPL, pass `--ui repl`..." line in the binary-missing warning (~line 137).

- [ ] **Step 2: Delete the `legacyInput` field + comment.**

Edit to remove:
```ts
  // REPL-only — hard error with --ui tui.
  /** Readline fallback (REPL-only). Hard-errors when used with --ui tui. */
  legacyInput?: unknown;
```

- [ ] **Step 3: Delete the `legacyInput === true` rejection block.**

Edit to remove the entire `if (opts.legacyInput === true) {...}` block (lines ~142-151) including the preceding 3-line comment.

- [ ] **Step 4: Update the binary-missing warning.**

The defensive guard at `runTuiLauncher`'s top is still meaningful for direct importers (tests, future callers). Update both lines:

Old:
```ts
    console.warn(
      'sov: sov-tui binary not found — install Go ≥ 1.24 and run `bun pm -g trust @yevgetman/sov && sov upgrade`.',
    );
    console.warn(
      '     For the readline REPL, pass `--ui repl` or `SOV_UI=repl` (or set `ui.surface=repl` in ~/.harness/config.json).',
    );
    return 70;
```

New:
```ts
    console.warn(
      'sov: sov-tui binary not found — install Go ≥ 1.24 and run `bun pm -g trust @yevgetman/sov && sov upgrade`.',
    );
    return 70;
```

Also update the preceding 5-line "Post-M11, main.ts pre-checks..." comment to reflect M13 behavior (`Post-M13, main.ts hard-errors before invoking the launcher; this branch is defense-in-depth for direct importers`).

- [ ] **Step 5: Run gate.**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: clean. Test count may drop slightly if `tests/cli/tuiLauncher.test.ts` had a `legacyInput`-rejection case — update accordingly.

- [ ] **Step 6: Commit.**

```bash
git add src/cli/tuiLauncher.ts tests/cli/tuiLauncher.test.ts && git commit -m "$(cat <<'EOF'
refactor(cli): drop --legacy-input + REPL hints from tuiLauncher (M13 T8)

With the readline REPL gone, the --legacy-input rejection block is
dead code, and the binary-missing warning's "fall back to --ui repl"
hint points at nothing. Cleaned both.

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 9: Docs sweep

**Goal:** Update `CLAUDE.md` boot block, `README.md`, `docs/usage.md`, and any code comments that reference `terminalRepl.ts:NNN` line numbers (now stale).

**Files:**
- Modify: `CLAUDE.md` (boot block snapshot reference)
- Modify: `AGENTS.md` (byte-identical mirror of CLAUDE.md per repo convention)
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: various `src/*.ts` and `tests/*.ts` files containing `terminalRepl` comment references (one-pass sweep)

- [ ] **Step 1: Find every code comment referencing terminalRepl.**

```bash
grep -rn "terminalRepl" /Users/julie/code/sovereign-ai-harness/src /Users/julie/code/sovereign-ai-harness/tests 2>/dev/null
```

These will all be in surviving files (terminalRepl.ts itself is deleted). Most look like:
```
// mirrors terminalRepl.ts:402-405
```
or
```
/* Same shape used in the REPL's modal renderer; see terminalRepl.ts:NNN. */
```

For each match, decide:
- If the comment's purpose is "pointer to historical source" — delete the pointer (it now points at a deleted file).
- If the comment's purpose is "this code mirrors that one" — keep the prose but drop the line-number citation.

- [ ] **Step 2: Apply each sweep edit one by one.**

Each is small. Don't try to batch — do one Edit per file to keep the changes reviewable.

- [ ] **Step 3: Update `README.md`.**

Find and update any "REPL" mentions. Open `README.md`, search for "REPL", "readline", "--ui", "terminalRepl". Replace with TUI-only language.

- [ ] **Step 4: Update `docs/usage.md`.**

Same as README — search/replace REPL language with TUI-only descriptions.

- [ ] **Step 5: Update `CLAUDE.md` boot block — point at the new M13 state snapshot.**

The boot block currently references `docs/state/2026-05-19-m12.md`. After T12 lands the new snapshot, this points there. **Defer this step until T12.** Mark this step `- [ ]` and revisit at the start of T12 (T12 will both write the snapshot AND update CLAUDE.md in the same commit).

- [ ] **Step 6: Run gate.**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: clean. Docs changes don't affect the suite.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
docs: sweep stale terminalRepl.ts references after M13 (T9)

Updated README, usage.md, and one-pass cleanup of code comments
referencing terminalRepl.ts:NNN line numbers (now stale after T2).

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 10: Parity audit — 4 parallel Opus subagents

**Goal:** Per Postmortem Rule 3, independently verify that M13's deletions haven't broken anything subtle. Four parallel Opus subagents read the post-M13 codebase from different angles.

**Files:** No file changes in this task. Audit only.

- [ ] **Step 1: Dispatch all four subagents in parallel.**

Use the `Agent` tool with `subagent_type: "general-purpose"` (or whatever specialized agent exists; default to general-purpose). All four go in a single message for parallel execution.

**Subagent 1 — Dead-symbol audit.**

Prompt:
```
You are auditing the post-M13 sovereign-ai-harness codebase for any surviving reference to a deleted symbol.

M13 deleted these files:
- src/ui/terminalRepl.ts
- src/cli/replDeprecation.ts (+ tests/cli/replDeprecation.test.ts)
- src/cli/surfaceResolver.ts (+ tests/cli/surfaceResolver.test.ts)
- src/ui/bracketedPaste.ts (+ test)
- src/ui/inlineShell.ts (+ test)
- src/ui/inputEditor.ts (+ test)
- src/ui/markdownStream.ts (+ test)
- src/ui/queuedQuestion.ts (+ test)
- src/ui/terminalMessages.ts (+ test)
- src/ui/thinking.ts (+ test)
- src/ui/toolSlot.ts (+ test)
- src/ui/transcript.ts (+ test)

M13 also removed these symbols from src/permissions/prompt.ts:
- buildReadlineAsker
- parseAskResponse
- ReadlineQuestion type

And removed these from src/cli/tuiLauncher.ts:
- TuiLaunchOptions.legacyInput field
- The `if (opts.legacyInput === true) {...}` rejection block

And these field/option names from src/main.ts:
- --ui flag
- --legacy-input flag
- The SOV_UI env handling (was inside surfaceResolver)
- The SOV_NO_DEPRECATION_WARNING env handling (was inside replDeprecation)

And this field from src/config/schema.ts:
- UiSchema.surface

Audit task: search src/ and tests/ for any remaining reference to any of these symbols (import, type, function call, comment with import statement). Report each match with file:line and surrounding context. If clean, report "no surviving references found."

Use grep aggressively. Report under 300 words.
```

**Subagent 2 — Dead-test audit.**

Prompt:
```
You are auditing the post-M13 sovereign-ai-harness codebase for orphaned tests.

M13 deleted many src/ files. The plan also deleted matching tests/ files. Audit task: enumerate every test file under tests/ and confirm that the source it tests still exists. Look especially at:

- tests/ui/*.test.ts — should match a src/ui/*.ts file
- tests/cli/*.test.ts — should match a src/cli/*.ts file
- tests/permissions/prompt.test.ts — surviving tests should only exercise serializeAskUser + previewToolInput

For each test file that imports from a no-longer-existing source, report file:line of the dead import.

Also run `cd /Users/julie/code/sovereign-ai-harness && bun run test 2>&1 | tail -50` and report any failing test that points at a missing-module error.

Report under 300 words.
```

**Subagent 3 — Docs/comment-claims audit.**

Prompt:
```
You are auditing the post-M13 sovereign-ai-harness codebase for documentation claims that the code no longer matches.

M13 removed the readline REPL surface entirely. Audit: search README.md, docs/usage.md, CLAUDE.md, AGENTS.md, and code comments under src/ and tests/ for any of:
- Claims that `sov` runs a REPL.
- Claims that `--ui repl` is supported.
- Claims that `SOV_UI=repl` is honored.
- Claims that `ui.surface=repl` in config is honored.
- Pointers like "terminalRepl.ts:NNN" or "see terminalRepl".
- Any mention of buildReadlineAsker, surfaceResolver, replDeprecation.

For each false claim or stale reference, report file:line and the offending text. Don't report state snapshots, ADRs, plans, or postmortems under docs/state/ or docs/postmortems/ or docs/plans/ — those are historical records and should be preserved.

Report under 300 words.
```

**Subagent 4 — Smoke-spec audit + behavior verification.**

Prompt:
```
You are auditing post-M13 sovereign-ai-harness end-to-end behavior.

Read src/main.ts (the .action body) and verify:
1. Bare `sov` invocation calls runTuiLauncher.
2. Missing sov-tui binary causes process.exit(1) with the expected stderr message.
3. There is NO call to runRepl, resolveSurface, or formatReplDeprecationMessage.
4. There is NO reference to opts.ui, opts.legacyInput.

Read src/cli/tuiLauncher.ts and verify:
1. The legacyInput-rejection block is gone.
2. The binary-missing warning no longer points at the readline REPL fallback.
3. runTuiLauncher's contract still matches what main.ts now calls it with.

Run `cd /Users/julie/code/sovereign-ai-harness && bun run typecheck 2>&1 | tail -20` and report.
Run `cd /Users/julie/code/sovereign-ai-harness && bun run test 2>&1 | tail -30` and report.

Report under 400 words.
```

- [ ] **Step 2: Review the four reports.**

Each report should come back as "no findings" or with specific file:line citations. For any HIGH-severity finding (broken import, missing module reference, false doc claim), fix inline before proceeding to T11.

- [ ] **Step 3: If any fixes were needed, run gate + commit.**

```bash
bun run lint && bun run typecheck && bun run test
git add -A && git commit -m "fix: address M13 parity audit findings (T10)"
```

If no fixes were needed, no commit in this task.

---

### Task 11: Smoke — 4 scenarios

**Goal:** Per spec §9, exercise the four boot-decision scenarios to verify M13 behavior end-to-end. Save outputs.

**Files:** No source changes. Smoke outputs go to `docs/state/2026-05-19-m13-smoke/`.

- [ ] **Step 1: Create smoke output directory.**

```bash
mkdir -p /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke
```

- [ ] **Step 2: Scenario 1 — Default `sov` boots TUI.**

```bash
cd /tmp
timeout 3 sov 2>&1 | head -20 > /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/01-default-boot.txt
echo "exit=$?" >> /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/01-default-boot.txt
```

Expected: the TUI's splash/intro renders. `timeout 3` kills the interactive session after 3 seconds. The captured output should show TUI-style decoration, not a readline prompt.

- [ ] **Step 3: Scenario 2 — sov-tui missing → hard error.**

```bash
# Find the sov-tui binary
TUI_BIN=$(which sov-tui)
echo "TUI_BIN=$TUI_BIN" > /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/02-missing-binary.txt

# Temporarily rename it
mv "$TUI_BIN" "${TUI_BIN}.bak"

# Run sov and capture
sov 2>&1 >> /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/02-missing-binary.txt
echo "exit=$?" >> /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/02-missing-binary.txt

# Restore
mv "${TUI_BIN}.bak" "$TUI_BIN"
```

Expected: stderr contains "sov: sov-tui binary not found. Install with:" + the bun command, exit code 1.

**Safety:** If anything fails between the `mv` and the restore-`mv`, the binary stays renamed. Wrap in a trap, or do a follow-up `ls "$TUI_BIN"` to verify restoration.

- [ ] **Step 4: Scenario 3 — `--ui repl` → Commander error.**

```bash
sov --ui repl 2>&1 > /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/03-unknown-flag.txt
echo "exit=$?" >> /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/03-unknown-flag.txt
```

Expected: Commander complains about unknown option `--ui`, non-zero exit code.

- [ ] **Step 5: Scenario 4 — `sov dispatch` still works.**

```bash
cd /tmp
printf "/help\n/quit\n" | sov dispatch 2>&1 > /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/04-dispatch.txt
echo "exit=$?" >> /Users/julie/code/sovereign-ai-harness/docs/state/2026-05-19-m13-smoke/04-dispatch.txt
```

Expected: dispatch prints help output, then exits cleanly on `/quit`. Exit code 0.

- [ ] **Step 6: Write the smoke README.**

Create `docs/state/2026-05-19-m13-smoke/README.md` summarizing the four scenarios with PASS/FAIL marks.

- [ ] **Step 7: Commit.**

```bash
git add docs/state/2026-05-19-m13-smoke && git commit -m "$(cat <<'EOF'
test(smoke): M13 boot-decision scenarios (T11)

4 scenarios — default-TUI boot, missing-binary hard error, unknown
--ui flag, dispatch mode. All PASS.

Part of M13 (terminalRepl removal).
EOF
)"
```

---

### Task 12: State snapshot + ADRs + close-out commit

**Goal:** Write the M13 close-out state snapshot, append the 4 ADRs to DECISIONS.md, update CLAUDE.md / AGENTS.md boot block, sync the backlog header.

**Files:**
- Create: `docs/state/2026-05-19-m13.md`
- Modify: `DECISIONS.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (byte-identical mirror)
- Modify: `docs/backlog/post-phase-13-4.md` (sync line)
- Modify: `docs/testing-log.md` (append entry)

- [ ] **Step 1: Write `docs/state/2026-05-19-m13.md`.**

Follow the style of `docs/state/2026-05-19-m12.md`. Include:
- HEAD + commit chain since M12
- Suite count (capture from final `bun run test` output)
- Lint + typecheck status
- Smoke results (cite §9 / smoke README)
- ADRs landed (M13-01..04)
- What does NOT work / known gaps after M13
- Behavioral notes worth knowing next session
- Postmortem-rule compliance check
- What's open / what's next (point at backlog #17 + flag Phase 16.1 as complete)

- [ ] **Step 2: Append ADRs M13-01..04 to `DECISIONS.md`.**

Follow the existing ADR format in the file. Each ADR has: ID, date, status (Accepted), context, decision, consequences.

- ADR M13-01 — Missing-binary fallback = hard error.
- ADR M13-02 — Drop `ui.surface` from config schema.
- ADR M13-03 — Drop `--ui` flag + `SOV_UI` env handling entirely.
- ADR M13-04 — Delete `src/cli/surfaceResolver.ts` outright.

- [ ] **Step 3: Update CLAUDE.md boot block.**

In the "Session boot" section, replace the M12 state snapshot reference (currently bullet 3) with the new M13 one. Update the description prose to reflect "Phase 16.1 M13 shipped — terminalRepl removal complete, Phase 16.1 closed."

In the "Current state" table, add a row for the new snapshot and move the M12 row down. The M11 / M11.5 / M10 etc. rows stay.

- [ ] **Step 4: Copy CLAUDE.md → AGENTS.md.**

```bash
cp CLAUDE.md AGENTS.md
diff CLAUDE.md AGENTS.md  # should produce no output
```

- [ ] **Step 5: Sync `docs/backlog/post-phase-13-4.md`.**

Update the "Last sync" header line to reflect M13 shipping. The header line is at line 7 of the backlog file.

Suggested wording: "**Last sync:** 2026-05-19 — Phase 16.1 M13 shipped (terminalRepl removal). Deleted src/ui/terminalRepl.ts (2334 LoC) + 9 REPL-only ui modules + their tests + src/cli/replDeprecation.ts + src/cli/surfaceResolver.ts + readline asker bits from src/permissions/prompt.ts. Dropped --ui flag, SOV_UI env, ui.surface config field. main.ts boot flow collapsed from 65 lines to ~13. 4 ADRs landed M13-01..04. Suite green at <FINAL>/0/14. 4/4 smoke pass. **Phase 16.1 closed.** Open backlog: 17."

- [ ] **Step 6: Append testing-log entry.**

Add a newest-first entry to `docs/testing-log.md` matching the format of recent entries. Include: date, scope (M13 close-out), suite count, smoke results, any caveats.

- [ ] **Step 7: Run final gate.**

```bash
bun run lint && bun run typecheck && bun run test
```

Capture the final test count to inject into the state snapshot.

- [ ] **Step 8: Final commit.**

```bash
git add docs/state/2026-05-19-m13.md DECISIONS.md CLAUDE.md AGENTS.md docs/backlog/post-phase-13-4.md docs/testing-log.md && git commit -m "$(cat <<'EOF'
docs(state): 2026-05-19 — Phase 16.1 M13 close-out (terminalRepl removal)

Phase 16.1 M13 shipped. terminalRepl.ts (2334 LoC) deleted along with
9 REPL-only ui modules, the M12 deprecation infrastructure, and the
M11 surface resolver. main.ts boot flow collapsed to a single TUI
launch path with hard-error on missing binary. 4 ADRs M13-01..04
landed. Phase 16.1 closed.

Suite green at <FINAL>/0/14. 4/4 smoke pass.

Part of M13 (terminalRepl removal).
EOF
)"
```

Replace `<FINAL>` with the actual count captured in Step 7.

- [ ] **Step 9: Run `sov upgrade`.**

Per the repo's standing rule (`docs/conventions/sov-upgrade.md`), any change under `src/` must be followed by `sov upgrade` to keep the global binary current.

```bash
sov upgrade
```

- [ ] **Step 10: Push.**

```bash
git push origin master
```

Per the repo's atomic-commit + autonomous-push convention.

---

## Self-review checklist (run at end of session)

- [ ] All 12 tasks completed.
- [ ] Final `bun run lint && bun run typecheck && bun run test` returns clean.
- [ ] 4/4 smoke scenarios PASS per `docs/state/2026-05-19-m13-smoke/`.
- [ ] `git status` is clean.
- [ ] `CLAUDE.md` and `AGENTS.md` byte-identical (`diff CLAUDE.md AGENTS.md` returns no output).
- [ ] `docs/testing-log.md` has a newest-first M13 entry.
- [ ] `docs/state/2026-05-19-m13.md` exists and is referenced from CLAUDE.md's Session boot block.
- [ ] Open backlog: #17 only.
- [ ] No file under `src/cli/` or `src/ui/` imports a deleted module.
- [ ] `grep -rn "terminalRepl\|surfaceResolver\|replDeprecation\|buildReadlineAsker\|parseAskResponse" src/ tests/` returns no hits.

If any item fails, do NOT close out the session — investigate the gap before claiming M13 complete.
