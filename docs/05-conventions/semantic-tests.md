# Semantic test triage

`bun run test:semantic` is opt-in (~5 min wall, ~$0.87 informational on subscription). The full framework reference lives in [`docs/06-testing/semantic-testing.md`](docs/06-testing/semantic-testing.md); this file is the **triage policy** — when to run, when to skip.

**Binary surface (2026-05-22 PM):** the suite drives `sov drive`, the headless line-driven LLM conversation surface introduced when the semantic suite broke after M13 (terminalRepl removal). The TUI cannot be driven via piped stdin (it needs a TTY); `sov drive` boots the same Hono server the TUI talks to and emits plain-text events to stdout. Run the suite against the locally-built binary (a `bun src/main.ts` shim works fine) when iterating on driveCommand itself, or via `sov upgrade` + the installed binary for full validation.

## GOTCHA: the suite tests whatever binary it resolves — which may be STALE

The framework spawns the binary it resolves; it does **not** run the repo's source by default. Resolution order (see `tests/semantic/run.ts` → `framework/driver.ts`):

1. `--binary <path>` flag (`bun run test:semantic -- --binary <path>`), else
2. `SEMANTIC_BINARY` env var, else
3. bare `sov` from `PATH`.

On a dev machine, bare `sov` is almost always a **stale source-mode / dev install** (e.g. `~/.bun/bin/sov` from an earlier `bun link`/`sov upgrade`) that **shadows the code you're editing**. So a default `bun run test:semantic` can silently green-light (or red-flag) the *old* binary while your working tree is never exercised. Observed during the 2026-06-06 A-C verification pass: `which sov` → `~/.bun/bin/sov` at `0.6.14`, while `package.json` was at `0.6.20` — a 6-patch gap. A "pass" there proves nothing about current code.

**To test CURRENT code, do one of:**

- **Run against source** — point the override at a thin `bun src/main.ts` shim and pass it via `SEMANTIC_BINARY` (or `--binary`):
  ```sh
  printf '#!/usr/bin/env bash\nexec bun "%s/src/main.ts" "$@"\n' "$PWD" > /tmp/sov-src && chmod +x /tmp/sov-src
  SEMANTIC_BINARY=/tmp/sov-src bun run test:semantic
  ```
- **Or refresh the dev install first** — `sov upgrade` (see [`sov-upgrade.md`](./sov-upgrade.md)) so the resolved `sov` picks up current master, then run the suite normally. (`sov upgrade` installs from the pushed branch, so make sure your work is pushed first — or use the source-shim path above to test an unpushed working tree.)

**ALWAYS confirm the driven binary before trusting a pass/fail.** Check that its `--version` matches `package.json`:

```sh
"${SEMANTIC_BINARY:-$(command -v sov)}" --version   # must match package.json "version"
```

If the version doesn't match, the suite is testing the wrong code — fix the override (or refresh the install) before reading anything into the result.

## When to run

Apply this triage:

| Change scope | Action |
|---|---|
| Doc-only / formatting | Skip |
| Touching one specific surface (single tool, single slash command, single permission rule path, single context surface) | Run the matching filter — `bun run test:semantic -- --filter <id-or-substring>` |
| Touching `src/core/query.ts`, `src/providers/`, `src/agent/sessionDb.ts` schema, or `src/permissions/canUseTool.ts` | Run the full suite |
| Before pushing a substantive feature batch to master | Run the full suite |
| Phase completion gate | Run the full suite + log it in `docs/06-testing/testing-log.md` |

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

**When you change `tests/semantic/suites/`, update [`docs/06-testing/semantic-testing.md`](docs/06-testing/semantic-testing.md) in the same commit** — coverage inventory, headline count, and the run-policy mapping table all must stay in sync with reality. If they drift, the triage policy lies.

Full mapping table (changed area → filter) and extension rules: [`docs/06-testing/semantic-testing.md#when-to-run-and-when-to-extend`](docs/06-testing/semantic-testing.md#when-to-run-and-when-to-extend).
