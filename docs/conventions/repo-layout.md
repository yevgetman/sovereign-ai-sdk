# Repo layout and conventions

## Tech stack

- **Runtime:** Bun.
- **Language:** TypeScript, strict mode.
- **Testing:** Bun's built-in test runner.
- **Lint / format:** Biome.
- **Style:** structurally mirrors `~/code/claude-code/` where sensible — look up the reference when in doubt about a pattern.

## Repo conventions

- Every tool uses `buildTool()`. No ad-hoc `{ name, call, ... }` objects.
- Every provider implements the `LLMProvider` interface. Don't call provider SDKs from outside `src/providers/`.
- Every `.ts` file has a short header comment naming its one responsibility.
- `.js` extensions in import paths (Bun convention, matches Claude Code).
- Empty directories under `src/` are phase landing zones. Do not delete them.
- No product-specific hardcoding in `src/` — Sovereign-AI-specific content belongs in the bundle. The runtime is supposed to be deployable verbatim to any client.

## Save paths for plans and specs

This project overrides the `superpowers:writing-plans` and `superpowers:brainstorming` skill defaults (`docs/superpowers/plans/` and `docs/superpowers/specs/`).

- **Plans:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- **Specs:** `docs/specs/YYYY-MM-DD-<topic>-design.md`

Do NOT create or write under `docs/superpowers/` — that directory has been intentionally removed.

## AGENTS.md mirrors CLAUDE.md

`AGENTS.md` is a byte-identical mirror of `CLAUDE.md`. Edit both in the same commit; verify with `diff CLAUDE.md AGENTS.md` (empty output expected).

## Phase discipline

Each phase should:

- Add one new abstraction or capability.
- Keep the harness running end-to-end throughout (no broken-for-three-days refactors).
- Exercise the new thing in a real scenario before the phase closes.
- Record design choices in `DECISIONS.md`.
