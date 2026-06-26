# Skill Import Shim + Tool-Scope Enforcement — Design Spec

**Date:** 2026-06-08
**Status:** Approved for implementation (autonomous build)
**Arc:** Part of the harness **ecosystem-openness** work — **A** (CC-skill import) + **B** (enforce skill `allowedTools`) ship together here → **C** (remote MCP transport) → **D** (plugin system, spec'd separately). A+B pair because B turns the tool restrictions A's imported skills declare into a real boundary.

## Goal

Make Claude Code skills load and run faithfully in this harness, and make a skill's declared `allowedTools` an actual security boundary (today it is advisory only).

## Background (verified, with file:line)

- Skills are markdown + YAML frontmatter (`src/skills/`). The harness frontmatter key is **camelCase `allowedTools`** (`src/skills/loader.ts:36-44`). Claude Code uses **hyphenated `allowed-tools`**, frequently as a **comma-separated string** (e.g. `allowed-tools: Read, Grep, Bash(git status:*)`), not a YAML list.
- `buildToolScope` (`src/commands/toolScope.ts:19`) is the **only** allow-list tool-restriction mechanism, and it is called from exactly one place — `src/cli/missionRun.ts:151` (agents). A skill's `allowedTools` is parsed, returned by `SkillTool`, and echoed to the model as text ("Allowed tools: …"), but **never enforced on the live tool pool** (confirmed: no other `buildToolScope` caller; `src/tools/SkillTool.ts:56,68` only return/echo it).
- `runtime.toolPool` is a **single shared array, mutated in place on reload** (`src/server/runtime.ts:1337-1338`). The pool is fixed at turn start (`src/core/query.ts:60,147` read `tools` once). **Implication:** per-turn scoping must build a fresh scoped copy and never mutate `runtime.toolPool`; mid-loop pool narrowing is not possible without re-architecting `query()`.
- The user `/skill` path is exactly `src/server/routes/turns.ts:151-163` (it replaces the turn text with the expanded body and currently discards the resolved skill object).

## Feature A — CC-skill import shim

### A1 — `allowed-tools` alias (parser-level)

Add a `z.preprocess` in front of `SkillFrontmatterSchema` (`src/skills/loader.ts:36`) that:

- aliases `allowed-tools` → `allowedTools` **only when `allowedTools` is absent** (no clobber); a file carrying both keeps the harness-native one.
- accepts a **comma-separated string** value and splits it into a trimmed, non-empty array (CC's common form), since the field schema is `z.array(z.string())` and would otherwise reject a string.

This makes any CC `SKILL.md` load natively with its tool list populated. **Export** `SkillFrontmatterSchema` so the importer (A2) can validate against it.

### A2 — `/skills import <path>` (distinct verb, normalize-on-write)

A distinct `import` verb (not folded into `install`, which stays byte-faithful). `importSkill()` in `src/skills/install.ts`:

1. Resolves the source (file or skill dir) — reuse the existing resolution logic (`install.ts:73-98`).
2. Parses the SKILL.md frontmatter with the real `yaml` parser (a justified divergence from `install.ts`'s name-only regex — import rewrites the whole frontmatter).
3. **Normalizes:** `allowed-tools` → `allowedTools` (+ comma-string split); synthesize `whenToUse` from `description` when absent (so imports don't trip the `validateWhenToUse` warning forever); record dropped/ignored CC keys (`model`, `license`, `argument-hint`, …).
4. **Validates** the normalized frontmatter against the exported loader schema — fail loud rather than land a broken skill.
5. Copies the whole source tree (bundled `references/`/`scripts/`) then overwrites the target SKILL.md with the canonical normalized content.
6. Returns `{ ok, name, installedAt, converted: string[], warnings: string[] }`.

Lands in `<harnessHome>/skills/<name>/`, parity with `install`. A `<root>/<name>/SKILL.md` directory skill there is classified **`community`** by `classifyUserSkill` (`loader.ts`) — the *safer* tier (blocks medium+critical guard findings), which is the intended stricter posture for an untrusted third-party import (NOT `trusted`). The guard scanner at load is the real safety boundary regardless of tier.

**Wiring (3 layers, mirror the existing `install` verb):** server route `POST /sessions/:id/skills/import` (`src/server/routes/skills.ts`); TUI transport `ImportSkill` (`packages/tui/internal/transport/skills.go`); TUI verb parser `case "import"` + result rendering of `converted`/`warnings` + usage strings (`packages/tui/internal/app/app.go`).

**Decision — CC glob syntax delta:** CC writes `Bash(git status:*)` (`:` glob); the harness matcher uses space + `*`/`**` (`src/permissions/rules.ts:83-101`). v1 **does not auto-translate** (translation is lossy/ambiguous). The importer **warns** when an `allowed-tools` entry is a `Bash(...)` pattern containing `:`, so the user can adjust. Most CC skills use bare tool names where the delta does not apply.

## Feature B — enforce skill `allowedTools` (turn-scoped, `/skill` path)

**Enforcement model (decided):** scope the **`/skill` user-invoked path** (`turns.ts:151-163`), **turn-scoped** — the restriction applies to the turn that consumes the skill body, then evaporates (lives entirely in a turn-local const; no persistence, no clearing logic, no resume hazard). The **`SkillTool` (model-invoked, mid-loop) path stays advisory** — narrowing the live pool mid-agentic-loop is too invasive (`query()` reads `tools` once at turn start). Rationale: the `/skill` path is where a user runs an untrusted imported skill (highest value, most tractable); turn-scoped is the simplest correct model.

**Mechanism:**

1. At `turns.ts:151-163`, retain `skill.allowedTools` (not just the expanded text); thread it into `runTurnInBackground` via a new `skillScope?: readonly string[]` param (pass it only when `body.kind === 'skill'` and the array is non-empty; `undefined` otherwise).
2. In `runTurnInBackground`, after `sessionCanUseTool` is built, compute:
   ```ts
   const scope = buildToolScope({
     allowedTools: skillScope,        // undefined/[] → identity (toolScope.ts:24)
     tools: runtime.toolPool,         // READS, never mutates the shared array
     canUseTool: sessionCanUseTool,
   });
   ```
3. Feed `scope.tools` + `scope.canUseTool` into **both** the `query()` call **and** `buildSessionToolContext`, so sub-agents forked mid-turn inherit the scoped pool (child ⊆ skill scope ⊆ runtime pool). `buildSessionToolContext` gains an effective-pool + canUseTool param **defaulting** to `runtime.toolPool`/`sessionCanUseTool` (preserves every existing caller, incl. the pinned subagent test).
4. `SkillTool` (`src/tools/SkillTool.ts:65-75`): add one sentence to the rendered result making the advisory nature explicit to the model.

**Empty-`allowedTools` = no restriction** is preserved for free (`buildToolScope` returns identity when the allow-list is empty/undefined). Non-skill turns are byte-identical to today.

**Key security property:** the scope is bound at turn setup, so even if the model invokes a skill mid-turn to try to widen scope, out-of-scope tool calls are denied (`'tool is outside slash-command scope'`, `toolScope.ts:32`). Composes correctly with the permission cascade (scope is an outer allow-list that only ever *removes* capability), agent scoping (`parentToolPool` is the scoped pool), and `SUBAGENT_EXCLUDED_TOOLS` (orthogonal child ceiling).

## Scope / non-goals (v1)

- B applies to the interactive **`/skill`** path only. Cron, the OpenAI server, and channels expand skills through separate seams that already run a safe posture — **out of scope** (documented).
- **`SkillTool` mid-loop hard-restriction is out of scope** (advisory + documented). Clean future upgrade: `SkillTool` writes a "pending scope" onto `SessionContext` honored at the next turn (same B seam) — flagged, not built.
- **No CC `:`-glob auto-translation** (warn only).
- **No per-skill `model`** (CC key ignored; warned on import).

## Test plan (TDD, RED→GREEN)

**A — parser alias (`tests/skills/loader.test.ts`):**
- `allowed-tools: [Read, Grep]` → `skill.allowedTools === ['Read','Grep']` (was `[]`).
- `allowed-tools: Read, Bash(git status:*)` (comma string) loads as `['Read','Bash(git status:*)']` (was a Zod reject).
- both keys present → harness-native `allowedTools` wins (no clobber).

**A — import (`tests/skills/import.test.ts`):**
- importing a CC `SKILL.md` writes a target whose frontmatter has `allowedTools:` and no `allowed-tools:`; `converted` lists the rewrite; `warnings` lists ignored `model`.
- bundled `references/`/`scripts/` copied to target.
- import refuses a skill that fails the loader schema (e.g. missing `description`).
- import synthesizes `whenToUse` from `description` (no `validateWhenToUse` warning on subsequent load).

**B — `/skill` enforcement (`tests/server/skillScope.test.ts`):**
- a `kind:'skill'` turn for a skill with `allowedTools:['Read']` → the `query()` `tools` (and `ToolContext.parentToolPool`) is filtered to `['Read']`.
- `canUseTool` denies a `Bash` call with `'tool is outside slash-command scope'` during a Read-only skill turn.
- `allowedTools:[]` and a plain non-skill turn both run against the **full** pool (no narrowing).
- intersection: `['Read','NonexistentTool']` → `tools === ['Read']`.
- no-mutation: `runtime.toolPool.length` unchanged after a scoped turn (guards the reload contract).
- sub-agent inheritance: a scoped turn that forks a sub-agent hands `parentToolPool === scope.tools`.

## Ship

TDD; full gate (`bun run lint && bun run typecheck && bun run test`); update `docs/03-cli-reference/usage.md` (the `/skills import` verb + a "porting a Claude Code skill" note + the B enforcement behavior) and `docs/04-extending/extending.md` (skill `allowedTools` is now enforced on the `/skill` path); append `docs/06-testing/testing-log.md`; atomic commits (A separate from B); push; `sov upgrade`; cut a release.
