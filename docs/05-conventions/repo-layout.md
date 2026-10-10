# Repo layout and conventions

## Tech stack

- **Application runtime:** Bun. **SDK/protocol:** Node >=20.19.0 and Bun >=1.2.0.
- **Language:** TypeScript, strict mode.
- **Testing:** Bun's built-in test runner.
- **Lint / format:** Biome.
- **Style:** structurally mirrors `~/code/claude-code/` where sensible — look up the reference when in doubt about a pattern.

## Repo conventions

- Every tool uses `buildTool()`. No ad-hoc `{ name, call, ... }` objects.
- Every provider implements the `LLMProvider` interface. Don't call provider SDKs from outside `packages/sdk/src/providers/`.
- Every `.ts` file has a short header comment naming its one responsibility.
- `.js` extensions in import paths (Bun convention, matches Claude Code).
- Empty directories under `src/` are phase landing zones. Do not delete them.
- No product-specific hardcoding in `src/` — Sovereign-AI-specific content belongs in the bundle. The runtime is supposed to be deployable verbatim to any client.

## Save paths for plans and specs

This project overrides the `superpowers:writing-plans` and `superpowers:brainstorming` skill defaults (`docs/superpowers/plans/` and `docs/superpowers/specs/`).

- **Plans:** `plans/YYYY-MM-DD-<feature-name>.md`
- **Specs:** `specs/YYYY-MM-DD-<topic>-design.md`

Do NOT create or write under `docs/superpowers/` — that directory has been intentionally removed.

## Canonical agent instructions

`AGENTS.md` is canonical for every harness. `CLAUDE.md` is a thin Claude-only
overlay that imports it. Keep shared rules in AGENTS.md; do not duplicate them.
The apex agent-file contract linked there owns this convention.

## Phase discipline

Each phase should:

- Add one new abstraction or capability.
- Keep the harness running end-to-end throughout (no broken-for-three-days refactors).
- Exercise the new thing in a real scenario before the phase closes.
- Record design choices in `DECISIONS.md`.
