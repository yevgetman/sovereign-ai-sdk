# Backlog Items 12 & 13 — Microcompaction Gaps + Stale Doc Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining microcompaction gaps (settings wiring + post-compaction guard) discovered when auditing backlog items 12 and 13, then mark both items done across all docs.

**Architecture:** Backlog item 13 (shell AST analysis) is already fully implemented in `src/permissions/shellSemantics.ts`. Backlog item 12 (microcompaction deepening) has two un-wired gaps: (1) `userSettings.microcompaction` is parsed by the schema but never passed to `query()` — the query loop always uses `DEFAULT_MICROCOMPACT_CONFIG`; (2) the post-compaction guard (run microcompaction on the freshly rebuilt `[summary, ...tail]` history after full compaction) is not called from `compactNow()` in `terminalRepl.ts`. Task 1 closes both code gaps. Task 2 closes the docs.

**Tech Stack:** TypeScript strict, Bun test runner, `src/compact/microcompact.ts`, `src/ui/terminalRepl.ts`, Zod settings schema.

---

### Task 1: Wire settings + post-compaction guard

**Files:**
- Modify: `src/compact/microcompact.ts` — add `buildMicrocompactConfig` export
- Modify: `src/ui/terminalRepl.ts` — import helper, pass config to `query()`, add post-compaction guard in `compactNow()`
- Modify: `tests/compact/microcompact.test.ts` — add tests for `buildMicrocompactConfig` and the post-compaction scenario

---

- [ ] **Step 1: Write failing tests for `buildMicrocompactConfig`**

Add to `tests/compact/microcompact.test.ts`, below the existing `buildToolNameMap` describe block:

```typescript
describe('buildMicrocompactConfig', () => {
  test('returns DEFAULT_MICROCOMPACT_CONFIG reference when settings undefined', () => {
    const cfg = buildMicrocompactConfig(undefined);
    expect(cfg).toBe(DEFAULT_MICROCOMPACT_CONFIG);
  });

  test('overrides enabled when specified', () => {
    const cfg = buildMicrocompactConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepRecent).toBe(DEFAULT_MICROCOMPACT_CONFIG.keepRecent);
    expect(cfg.triggerThresholdPct).toBe(DEFAULT_MICROCOMPACT_CONFIG.triggerThresholdPct);
    expect(cfg.compactableTools).toBe(DEFAULT_MICROCOMPACT_CONFIG.compactableTools);
  });

  test('overrides keepRecent when specified', () => {
    const cfg = buildMicrocompactConfig({ keepRecent: 10 });
    expect(cfg.keepRecent).toBe(10);
    expect(cfg.enabled).toBe(DEFAULT_MICROCOMPACT_CONFIG.enabled);
    expect(cfg.triggerThresholdPct).toBe(DEFAULT_MICROCOMPACT_CONFIG.triggerThresholdPct);
  });

  test('overrides triggerThresholdPct when specified', () => {
    const cfg = buildMicrocompactConfig({ triggerThresholdPct: 60 });
    expect(cfg.triggerThresholdPct).toBe(60);
    expect(cfg.enabled).toBe(DEFAULT_MICROCOMPACT_CONFIG.enabled);
    expect(cfg.keepRecent).toBe(DEFAULT_MICROCOMPACT_CONFIG.keepRecent);
  });

  test('overrides all specified fields simultaneously, preserves compactableTools', () => {
    const cfg = buildMicrocompactConfig({ enabled: false, keepRecent: 3, triggerThresholdPct: 20 });
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepRecent).toBe(3);
    expect(cfg.triggerThresholdPct).toBe(20);
    expect(cfg.compactableTools).toBe(DEFAULT_MICROCOMPACT_CONFIG.compactableTools);
  });
});
```

Add to the imports at the top of the test file (alongside the existing imports from `../../src/compact/microcompact.js`):
```typescript
import {
  DEFAULT_MICROCOMPACT_CONFIG,
  buildMicrocompactConfig,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../../src/compact/microcompact.js';
```

- [ ] **Step 2: Run failing tests**

```bash
cd /Users/julie/code/sovereign-ai-harness
bun test tests/compact/microcompact.test.ts --filter "buildMicrocompactConfig" 2>&1 | tail -15
```

Expected: FAIL — `buildMicrocompactConfig` is not exported from `microcompact.ts`.

- [ ] **Step 3: Add `buildMicrocompactConfig` to `src/compact/microcompact.ts`**

Add this function at the end of the file, after `buildToolNameMap`:

```typescript
/**
 * Merges user settings onto DEFAULT_MICROCOMPACT_CONFIG. Returns the default
 * reference unchanged when no settings are provided, so callers can use
 * reference equality to detect a no-op override.
 */
export function buildMicrocompactConfig(
  settings?: { enabled?: boolean; keepRecent?: number; triggerThresholdPct?: number },
): MicrocompactConfig {
  if (!settings) return DEFAULT_MICROCOMPACT_CONFIG;
  return {
    ...DEFAULT_MICROCOMPACT_CONFIG,
    ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
    ...(settings.keepRecent !== undefined ? { keepRecent: settings.keepRecent } : {}),
    ...(settings.triggerThresholdPct !== undefined
      ? { triggerThresholdPct: settings.triggerThresholdPct }
      : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify `buildMicrocompactConfig` tests pass**

```bash
bun test tests/compact/microcompact.test.ts --filter "buildMicrocompactConfig" 2>&1 | tail -15
```

Expected: 5/5 PASS.

- [ ] **Step 5: Wire settings to `query()` in `terminalRepl.ts`**

**5a — Add imports** at line ~30, modify the compactor import line and add a microcompact import:

```typescript
import { compactSession, shouldCompactProactively } from '../compact/compactor.js';
import {
  buildMicrocompactConfig,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../compact/microcompact.js';
```

**5b — Pass `microcompactConfig` to `query()`**. The `query()` call starts at line ~1392. Find this block:

```typescript
        ...(userSettings.behavior?.maxToolCallsBeforeCheckin !== undefined
            ? { maxToolCallsBeforeCheckin: userSettings.behavior.maxToolCallsBeforeCheckin }
            : {}),
```

Add `microcompactConfig` right after it:

```typescript
        ...(userSettings.behavior?.maxToolCallsBeforeCheckin !== undefined
            ? { maxToolCallsBeforeCheckin: userSettings.behavior.maxToolCallsBeforeCheckin }
            : {}),
        microcompactConfig: buildMicrocompactConfig(userSettings.microcompaction),
```

- [ ] **Step 6: Add post-compaction guard to `compactNow()`**

`compactNow()` starts at line ~1713. The full function currently reads:

```typescript
    async function compactNow() {
      const result = await compactSession({
        db,
        sessionId: activeSessionId,
        model: activeModel,
        providerName,
        systemPrompt,
        history,
        warn: (message) => process.stderr.write(chalk.yellow(`[compact] ${message}\n`)),
      });
      activeSessionId = result.newSessionId;
      toolContext.sessionId = activeSessionId;
      history.length = 0;
      history.push(
        { role: 'assistant', content: [{ type: 'text', text: result.summary }] },
        ...result.tail,
      );
      return result;
    }
```

Replace it with:

```typescript
    async function compactNow() {
      const result = await compactSession({
        db,
        sessionId: activeSessionId,
        model: activeModel,
        providerName,
        systemPrompt,
        history,
        warn: (message) => process.stderr.write(chalk.yellow(`[compact] ${message}\n`)),
      });
      activeSessionId = result.newSessionId;
      toolContext.sessionId = activeSessionId;
      history.length = 0;
      history.push(
        { role: 'assistant', content: [{ type: 'text', text: result.summary }] },
        ...result.tail,
      );
      // Post-compaction guard: clear stale tool results from the tail so the
      // child session doesn't start bloated with results the summary already covers.
      const mcCfg = buildMicrocompactConfig(userSettings.microcompaction);
      if (mcCfg.enabled) {
        const toolNameMap = buildToolNameMap(history);
        if (shouldMicrocompact(history, mcCfg, toolNameMap)) {
          const { messages: mcHistory, result: mcResult } = microcompact(
            history,
            toolNameMap,
            mcCfg,
          );
          if (mcResult.cleared > 0) {
            history.length = 0;
            history.push(...mcHistory);
          }
        }
      }
      return result;
    }
```

- [ ] **Step 7: Run lint + typecheck**

```bash
cd /Users/julie/code/sovereign-ai-harness
bun run lint 2>&1 | grep -v "^$\|warn" | tail -20
bun run typecheck 2>&1 | tail -20
```

Expected: clean (0 errors; pre-existing shellSemantics.ts warnings are acceptable).

- [ ] **Step 8: Run full test suite**

```bash
bun run test 2>&1 | tail -10
```

Expected: all tests pass (baseline was 1778/1778 before this change; new total should be 1783/1783 with the 5 new tests).

- [ ] **Step 9: Commit**

```bash
git add src/compact/microcompact.ts src/ui/terminalRepl.ts tests/compact/microcompact.test.ts
git commit -m "feat(microcompact): wire settings config + post-compaction guard"
```

---

### Task 2: Close items 12 & 13 in docs

**Files:**
- Modify: `docs/post-phase-13-4-backlog.md` — mark items 12 and 13 complete
- Modify: `CLAUDE.md` — remove items 12 and 13 from the open-backlog references (two places)
- Modify: `docs/state-of-build-2026-05-11.md` — update the open backlog count (one place)

No tests needed for a docs-only commit.

---

- [ ] **Step 1: Update `docs/post-phase-13-4-backlog.md`**

Find item 12 (around line 207):

```markdown
- Priority: P3
- Status: open
- Source: qwen-amendment-build-plan
- Notes: We already have basic microcompaction (`src/core/query.ts:330+`). The qwen-amendment deepening adds tool-result-aware compaction strategies. ~1 session.
```

Replace with:

```markdown
- Priority: P3
- Status: **complete (2026-05-11)** — `microcompact.ts` (184 lines, 18 tests) delivered the full qwen-amendment spec: context-percentage trigger, per-part clearing, compactable tool set, keep-recent, current-turn protection. Two gaps discovered during audit and closed in this session: (1) `userSettings.microcompaction` was parsed but never passed to `query()` — fixed by adding `buildMicrocompactConfig()` and wiring it at the call site; (2) post-compaction guard (run microcompaction on freshly rebuilt `[summary, ...tail]` history after full compaction) was unimplemented — added to `compactNow()` in `terminalRepl.ts`. Item 13 (shell AST) also confirmed done.
- Source: qwen-amendment-build-plan
```

Find item 13 (around line 215):

```markdown
- Priority: P3
- Status: open
- Source: qwen-amendment-build-plan
- Notes: Adds AST-based shell-command analysis (e.g., `rm -rf` detection at the AST level rather than regex). ~1 session.
```

Replace with:

```markdown
- Priority: P3
- Status: **complete (2026-04-28, commit `194b4e3`)** — `src/permissions/shellSemantics.ts` (437 lines, 233 test lines) delivered the full qwen-amendment spec: hand-written quote-aware tokenizer, 60+ command handlers (read/write/edit/web/git), transparent prefix stripping (sudo/timeout/env/nice/nohup), redirect-aware write promotion, pattern-first grep path extraction, unsafe-pattern detection (command substitution, eval, variable-in-command-position). Status was stale in this backlog — implementation predated the backlog item.
- Source: qwen-amendment-build-plan
```

- [ ] **Step 2: Update `CLAUDE.md` — first stale reference**

Find the paragraph in CLAUDE.md that contains:

```
4 backlog items remain open (12, 13, 17, 24) — all P3+, each warrants a focused session. See `docs/state-of-build-2026-05-07.md` for the full close-out snapshot and `docs/post-phase-13-4-backlog.md` for backlog detail.
```

Replace `4 backlog items remain open (12, 13, 17, 24)` with `2 backlog items remain open (17, 24)`.

- [ ] **Step 3: Update `CLAUDE.md` — second stale reference**

Find the paragraph that contains:

```
The P3+ backlog items (12, 13, 17, 24 — see `docs/post-phase-13-4-backlog.md`) remain open.
```

Replace `(12, 13, 17, 24` with `(17, 24`.

- [ ] **Step 4: Update `docs/state-of-build-2026-05-11.md`**

Find the line (around line 13):

```
The 4 open P3+ backlog items (12, 13, 17, 24) remain untouched. None block further build-plan phases.
```

Replace with:

```
Backlog items 12 and 13 (microcompaction settings wiring + post-compaction guard; shell AST analysis) closed 2026-05-11. 2 open P3+ backlog items remain (17, 24). None block further build-plan phases.
```

Find the line near the bottom (around line 64):

```
- **If picking up backlog:** items 12, 13, 24 are half-day each; item 17 is multi-day.
```

Replace with:

```
- **If picking up backlog:** item 24 is done; item 17 is multi-day. Backlog items 12 and 13 are closed.
```

- [ ] **Step 5: Lint check (docs only — no typecheck needed)**

```bash
bun run lint 2>&1 | grep -v "^$\|warn" | tail -10
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add docs/post-phase-13-4-backlog.md CLAUDE.md docs/state-of-build-2026-05-11.md
git commit -m "docs: close backlog items 12 and 13 — microcompaction gaps + shell AST done"
```

---

## After both tasks

```bash
git push origin master
sov upgrade
```

---

## Self-review

**Spec coverage:**
- `buildMicrocompactConfig` exported from `microcompact.ts` ✓
- Settings wired to `query()` via `microcompactConfig: buildMicrocompactConfig(userSettings.microcompaction)` ✓
- Post-compaction guard in `compactNow()` after `history.push(summary, ...tail)` ✓
- 5 unit tests for `buildMicrocompactConfig` covering: undefined → reference equality, enabled override, keepRecent override, triggerThresholdPct override, all-fields override ✓
- `compactableTools` preserved from defaults (not in schema, not overrideable by settings) ✓
- Docs: backlog items 12 and 13 marked complete ✓
- Docs: CLAUDE.md two references updated ✓
- Docs: state-of-build-2026-05-11.md updated ✓

**Placeholder scan:** None.

**Type consistency:** `buildMicrocompactConfig` takes `{ enabled?: boolean; keepRecent?: number; triggerThresholdPct?: number } | undefined` which matches `z.infer<typeof MicrocompactionSchema> | undefined` — the exact type of `userSettings.microcompaction`. `MicrocompactConfig` return type is fully required (no optionals), so passing to `query()` as `microcompactConfig` satisfies `QueryParams.microcompactConfig?: MicrocompactConfig`. ✓
