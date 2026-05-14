# Keep the global `sov` binary in sync

After pushing changes that affect the runtime (anything under `src/` or `bundle-default/`), run `sov upgrade` so the global `sov` binary picks up the new master.

The user's `sov` is a Path A install (`bun install -g git+ssh://…`) — a cached copy under `~/.bun/install/global/`, NOT a live symlink to this working tree. Without the upgrade step the user keeps running the previous SHA and any test the user runs against `sov` will hit stale code.

As of 2026-05-05, `sov upgrade` defaults to wiping Bun's install cache, so it reliably installs latest master in one shot.

## When to skip

Skip the upgrade only when the changes are confined to `tests/`, `docs/`, or other non-runtime paths — those don't affect the binary.

When in doubt, run it. The cost is ~5–10 seconds; the cost of a stale binary is the user thinking they're testing your fix when they're actually testing the previous version.

## Phase 16.1 note — `packages/tui/`

`sov upgrade` also triggers the package's postinstall hook, which rebuilds `bin/sov-tui` from `packages/tui/`. The TUI binary requires Go ≥ 1.24 on PATH.

- If Go is missing, the install succeeds and `sov --ui repl` (the default) still works; `sov --ui tui` falls back to repl with a one-line warning.
- Changes under `packages/tui/` therefore have the same "run `sov upgrade`" obligation as changes under `src/`.

## First-install gotcha

On first install only, Bun's global installer blocks postinstall scripts by default. If `bin/sov-tui` is missing after `bun install -g`, run:

```bash
bun pm -g trust @yevgetman/sov
```

Then re-run `sov upgrade`. Subsequent upgrades pick up the trusted entry automatically.
