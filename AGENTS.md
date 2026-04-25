# Instructions for Claude Code sessions developing this repo

You are working on the **Sovereign AI agent runtime** — TypeScript code, not documents. This repo is a Claude-Code-style harness (per ADR H-0003 in the sister `sovereign-ai-docs` repo) that reads a *harness bundle* (the docs repo, or a client's extracted bundle) and drives an LLM conversation against it.

If you need business context (what Sovereign AI is, what the harness does, why), read it in `~/code/sovereign-ai-docs/` — do not re-learn it here. This repo contains code and code conventions only.

## Session boot (minimal — this is a code repo)

1. This file.
2. `README.md`.
3. `~/code/sovereign-ai-docs/harness/docs/runtime-scaffold-plan.md` — the phase plan this repo implements.
4. `~/Desktop/harness-build-plan.md` — the reference phased plan (Claude Code style).
5. `~/Desktop/agent-harness-design-lessons.md` — 12 unifying design principles.
6. `~/code/claude-code/src/` — the architectural reference. Look up specific patterns there when a design question comes up.

## Tech stack

- **Runtime:** Bun.
- **Language:** TypeScript, strict mode.
- **Testing:** Bun's built-in test runner.
- **Lint / format:** Biome.
- **Style:** structurally mirrors `~/code/claude-code/` where sensible — look up the reference when in doubt about a pattern.

## Design principles — don't relitigate

Per ADR H-0003 and the three desktop summary documents, these are locked:

1. **Async-generator turn loop.** `async function* query(): AsyncGenerator<StreamEvent | Message, Terminal>` from day one. Never collapse to Promise-returning.
2. **Content-block internal messages.** `Message` carries an array of `ContentBlock`s (text / thinking / tool_use / tool_result / image). Providers translate at the boundary.
3. **Fail-closed tool defaults.** `buildTool()` spreads defaults first, user overrides last. `isConcurrencySafe` and `isReadOnly` default to `false`.
4. **Per-invocation concurrency.** `isConcurrencySafe(input)` takes the actual arguments, not a class-level flag.
5. **Permissions are transformable.** `checkPermissions` returns `{ behavior, updatedInput?, reason? }` — rules can normalise input, not just gate it.
6. **Segmented cacheable system prompts.** Static to dynamic, ephemeral cache marker at the boundary.
7. **Uniform Tool interface.** MCP tools, sub-agents, native tools, skill invocations — all flow through the same pipe.
8. **Sub-agents are recursion.** An `AgentTool` calls `query()` with a filtered context. No parallel execution engine.
9. **Bundle-as-data contract.** Runtime reads `<bundle>/business/` + `<bundle>/harness/schemas/`, writes `<bundle>/state/`. Never writes to tier-1 or tier-2 content.

When in doubt, read the corresponding section in `~/Desktop/agent-harness-design-lessons.md`.

## Repo conventions

- Every tool uses `buildTool()`. No ad-hoc `{ name, call, ... }` objects.
- Every provider implements the `LLMProvider` interface. Don't call provider SDKs from outside `src/providers/`.
- Every `.ts` file has a short header comment naming its one responsibility.
- `.js` extensions in import paths (Bun convention, matches Claude Code).
- Empty directories under `src/` are phase landing zones. Do not delete them.
- No product-specific hardcoding in `src/` — Sovereign-AI-specific content belongs in the bundle. The runtime is supposed to be deployable verbatim to any client.

## Phases — where we are

Phases 0 through 9 complete (2026-04-25). Next phase: **Phase 9.5** (skills production upgrade). Do not start Phase 9.5 unless explicitly requested. See `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` for per-phase deliverables; `runtime-scaffold-plan.md` covers the Phase-0 layout that this repo was seeded against.

Each phase should:
- Add one new abstraction or capability.
- Keep the harness running end-to-end throughout (no broken-for-three-days refactors).
- Exercise the new thing in a real scenario before the phase closes.
- Record design choices in `DECISIONS.md` (add when first non-trivial choice comes up).

## Lint before committing

Run `bun run lint` and `bun run test` before every commit. Commit atomically — one logical change per commit. This matches the rule in `sovereign-ai-docs/CLAUDE.md`.

## Commit and push

Same rule as the docs repo: autonomous add / commit / push after every working change. Push target is `origin/master` once the remote is configured.
