# Semantic test triage

`bun run test:semantic` is opt-in (~5 min wall, ~$0.87 informational on subscription). The full framework reference lives in [`../semantic-testing.md`](../semantic-testing.md); this file is the **triage policy** — when to run, when to skip.

**Binary surface (2026-05-22 PM):** the suite drives `sov drive`, the headless line-driven LLM conversation surface introduced when the semantic suite broke after M13 (terminalRepl removal). The TUI cannot be driven via piped stdin (it needs a TTY); `sov drive` boots the same Hono server the TUI talks to and emits plain-text events to stdout. Run the suite against the locally-built binary (a `bun src/main.ts` shim works fine) when iterating on driveCommand itself, or via `sov upgrade` + the installed binary for full validation.

## When to run

Apply this triage:

| Change scope | Action |
|---|---|
| Doc-only / formatting | Skip |
| Touching one specific surface (single tool, single slash command, single permission rule path, single context surface) | Run the matching filter — `bun run test:semantic -- --filter <id-or-substring>` |
| Touching `src/core/query.ts`, `src/providers/`, `src/agent/sessionDb.ts` schema, or `src/permissions/canUseTool.ts` | Run the full suite |
| Before pushing a substantive feature batch to master | Run the full suite |
| Phase completion gate | Run the full suite + log it in `docs/testing-log.md` |

When in doubt, run the full suite — five minutes and a dollar of subscription value is cheap insurance.

## When to extend

Add a new semantic test when shipping:

- A new tool
- A new slash command
- A new permission rule path
- A new context surface
- Fixing a bug that should never regress

At phase completion, audit user-visible behaviors and ensure each has at least one case.

## Keep the coverage doc in sync

**When you change `tests/semantic/suites/`, update [`../semantic-testing.md`](../semantic-testing.md) in the same commit** — coverage inventory, headline count, and the run-policy mapping table all must stay in sync with reality. If they drift, the triage policy lies.

Full mapping table (changed area → filter) and extension rules: [`../semantic-testing.md#when-to-run-and-when-to-extend`](../semantic-testing.md#when-to-run-and-when-to-extend).
