# Visual TUI screenshots

Agent-driven visual QA via VHS. Drives `sov-tui` to specific states and renders PNG screenshots that the agent can `Read` and judge.

```bash
bun run visual           # render every scenario
bun run visual splash    # render one
```

Output: `.harness/visual/output/<name>.png` (gitignored, regenerated on demand).

**Full documentation:** [`docs/05-conventions/visual-tui-qa.md`](../../docs/05-conventions/visual-tui-qa.md) — the record of truth for configuration, scenario conventions, runner semantics, and workflow patterns.
