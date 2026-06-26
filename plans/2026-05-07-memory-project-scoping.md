# Memory project-scoping (Backlog Item 19) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Stop `MEMORY.md` content from cross-pollinating between unrelated projects. Add an optional per-project memory layer alongside the existing global MEMORY.md. USER.md stays global.

**Architecture:** Two-tier file layout. Global `<harnessHome>/memory/MEMORY.md` keeps the existing role (user/feedback-flavored notes that apply everywhere). New `<harnessHome>/memory/projects/<projectId>/MEMORY.md` holds project-specific notes. Loader unions both into the snapshot when a project is detected. Writes route via a new `scope` argument on `MemoryTool`. Project identity comes from bundle manifest field (preferred) → canonical bundle-path hash → git remote. When neither bundle nor git repo is detected, the harness runs in "general-purpose" mode: no project memory loaded or written.

**Tech stack:** TypeScript + bun:test, Bun runtime, Biome lint.

---

## Locked design decisions (from 2026-05-07 design conversation)

| Question | Decision |
|---|---|
| Architecture | Two-tier (global + per-project). USER.md untouched. |
| Project sources | Bundle (manifest `projectId` if present, else hash of canonical bundle path) OR git repo (existing `getProjectId(cwd)` from Phase 13.4). |
| Non-project mode | No project memory loaded or written. System prompt tells the agent. `MemoryTool` rejects `scope: 'project'` when no projectId. |
| Migration | None automatic. Existing MEMORY.md stays as global. The 2200-char cap means manual cleanup is feasible if desired. |
| Conflict | Both load. Snapshot renders global first, then project closer to the user message (soft "later wins" precedence). |
| Write path | Agent picks `scope: 'global' \| 'project'` explicitly via MemoryTool. Default: `project` when projectId exists, else `global`. |
| Cap | Each file independently capped at 2200 chars. User gets 2× budget when on a project — also a feature. |

## File map

- `src/memory/scope.ts` (new) — `resolveProjectScope({cwd, bundlePath, harnessHome})` returns `{kind, id, name} | {kind: 'none'}`. Tries bundle manifest → canonical bundle hash → git via `learning/project.ts`.
- `src/memory/bounded.ts` (modify) — add `projectMemoryPath`, `readProjectMemory`, `replaceProjectMemoryFile`. Keep existing globals untouched.
- `src/memory/provider.ts` (modify) — `BuiltinMarkdownMemoryProvider` takes optional project scope. `prefetchSnapshot` reads both files when scope present.
- `src/memory/injection.ts` (modify) — `formatMemorySnapshot` accepts optional project block; renders `<MEMORY.md scope="project" project="<id>">`.
- `src/tools/MemoryTool.ts` (modify) — new `scope` field. Defaults from `ToolContext.projectScope`. Routes writes. Rejects `project` scope when no projectId.
- `src/tool/types.ts` (modify) — `ToolContext.projectScope?: ProjectScope`.
- `src/ui/terminalRepl.ts` (modify) — call `resolveProjectScope` at session boot, plumb through MemoryProvider + ToolContext.
- `src/agent/systemPrompt.ts` (or wherever the prompt is composed) — new memory-scope segment.
- Bundle manifest schema — `projectId?: string` field in the existing bundle index/manifest. Document in `docs/bundle-format.md` (or equivalent). Update `bundle-default/` example to include the field (optional, leave commented out — it's a sample).

## Task list

Each task ships its own commit. Tests live with the change.

### Round 1 (parallel — independent file areas)

**Task 1 — `resolveProjectScope` helper.** Pure function in `src/memory/scope.ts`. Bundle-manifest lookup → canonical-path hash → git. Returns `{kind: 'project', id, name} | {kind: 'none'}`. Reuses `learning/project.ts:getProjectId` for the git path. Tests: bundle-with-manifest, bundle-without-manifest (hash fallback), git-repo, scratch-dir (none), bundle takes precedence over git when both available.

**Task 2 — Two-tier paths in `bounded.ts`.** Add `projectMemoryPath(harnessHome, projectId)`, `readProjectMemoryFile`, `replaceProjectMemoryFile`. Mirror existing global helpers (same 2200 cap). Tests: read-when-missing returns empty; read-after-write round-trip; cap enforcement; mkdir of `projects/<id>/`.

**Task 3 — Bundle manifest `projectId` field.** Add to schema (`src/bundle/schema.ts` or similar — needs a survey first). Update `bundle-default/index.yaml` (or whichever manifest file is canonical) — add commented-out example so it's discoverable. Document in inline comment + `src/bundle/README.md`. Tests: parse with field, parse without field, parse with invalid type.

### Round 2 (after Round 1 — depends on Tasks 1+2)

**Task 4 — Provider scope-aware snapshot.** `BuiltinMarkdownMemoryProvider` constructor takes optional `projectScope`. `prefetchSnapshot` reads global + project (when scope present), formats both into the snapshot using `formatMemorySnapshot` (Task 5 below extends it). `injection.ts` extended to render `<MEMORY.md scope="project" project="<id>">` block. Tests: snapshot when only global; snapshot with both; snapshot when project file empty; snapshot when no scope (global-only).

**Task 5 — `MemoryTool` scope argument.** New `scope: z.enum(['global', 'project']).optional()`. Default: from `ToolContext.projectScope` (project if available, else global). Reject `scope: 'project'` when no projectId — `{status: 'error', summary, next_actions}` envelope. Route view + replace to the right file. Tests: default behavior in project context; default behavior in non-project context; explicit global; explicit project; rejection when project not available; existing global tests still pass.

### Round 3 (after Round 2 — integration)

**Task 6 — terminalRepl wiring + system prompt segment.** Resolve scope at session boot. Plumb through `MemoryProvider` + `ToolContext.projectScope`. Add scope segment to the system prompt (Architecture: paths, defaults, when to use which scope, what happens in non-project mode). Smoke test: REPL boot in project dir → tool list shows MemoryTool default-project; REPL boot in `/tmp/scratch` → MemoryTool defaults global; soak via `printf` pipeline confirms snapshot composition.

## Self-review notes

- USER.md is untouched throughout — verify no path in this plan modifies it.
- `MEMORY.md` global path is unchanged — existing content stays where it is.
- Each task is independently testable + committable.
- Round 1 tasks are parallel-safe (different files: `scope.ts` vs. `bounded.ts` vs. `bundle/schema.ts`).
- Round 2 tasks are parallel-safe (`provider.ts`+`injection.ts` vs. `MemoryTool.ts`+`tool/types.ts`).
- Round 3 is sequential — the integration step.
- Lint, typecheck, full suite must pass at every commit.
- After all tasks ship: push to origin/master + `sov upgrade` per CLAUDE.md.

## Out of scope (explicit punt)

- LLM-assisted migration of existing MEMORY.md to split entries by inferred scope. Manual cleanup if desired; the cap is small.
- Cross-project insight detection ("memory X says TDD; user is in another project — should it apply?"). Future work; current design lets the agent rely on global memory for cross-cutting preferences.
- "Agent semantically determines if cwd is a project mid-session." Defer until evidence demands it; the bundle/git-repo split is the deterministic baseline.
- Per-entry frontmatter / type tagging. The bounded-MEMORY.md format stays as-is (single bounded markdown). Routing happens at the file layer, not the entry layer.
