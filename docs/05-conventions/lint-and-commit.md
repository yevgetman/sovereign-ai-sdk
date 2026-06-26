# Lint and commit gate

## The pre-commit gate

Run all three before every commit. **All three must pass.**

```bash
bun run lint        # Biome — style and format
bun run typecheck   # tsc --noEmit — type-checking
bun run test        # Bun's built-in test runner
```

Why all three:

- `bun run lint` runs Biome which catches style/format issues but does NOT do TypeScript type-checking.
- `bun run typecheck` runs `tsc --noEmit` and catches things like wrong-scope identifiers and `exactOptionalPropertyTypes` violations that would slip through Biome and Bun's runtime test executor — Bun runs JS-style and doesn't enforce types at test time.
- Skipping typecheck is how the `settings is not defined` runtime bug in 2026-05-05's Phase 13 commits made it to master.

## Atomic commits

One logical change per commit. Mirrors the rule in `sovereign-ai-docs/CLAUDE.md`.

If you've made multiple unrelated edits, commit them one at a time. A larger number of small commits is the right error to make in a long-lived repo where `git log` is the durable record of why state changed.

## Push autonomously

Same rule as the docs repo: autonomous add / commit / push after every working change. Push target is `origin/master`.

Do this without asking. If a commit or push fails (hook, network, conflict), surface the error and stop — don't force through it.

## Commit message format

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Attribution is disabled globally via `~/.claude/settings.json`.
