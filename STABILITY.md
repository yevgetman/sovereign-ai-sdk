# Stability & Semver Policy — `@yevgetman/sov-sdk` + `@yevgetman/sov-protocol`

This policy covers the two published open packages. The repo root
(`@yevgetman/sov`, the private wrapper) is not published and carries no
stability promise.

## What is the public API

**The public API of each package is the set of export NAMES on its `.` entry:**

- `@yevgetman/sov-sdk` → the `packages/sdk/src/sdk.ts` barrel (Contract #1)
- `@yevgetman/sov-protocol` → the `packages/protocol/src/index.ts` barrel (Contract #2)

Both surfaces are **frozen by surface-snapshot tests** — the enforcement is
mechanical, not aspirational:

- `packages/sdk/tests/surface.test.ts`
- `packages/protocol/tests/surface.test.ts`

Each snapshot pins the exact sorted set of runtime value exports (any
accidental addition/removal/rename fails CI) plus a typecheck-only witness
that references every documented `export type` name (a removed/renamed type
breaks `bun run typecheck`).

## Semver rules

| Change | Bump |
|---|---|
| Removing or renaming a `.` entry export (value or type) | **major** |
| Adding a `.` entry export (snapshot updated deliberately, same commit) | **minor** |
| Everything else (fixes, internal changes, deep-subpath changes) | **patch** (or rides along) |

**Type SHAPES are not frozen.** Only export names are pinned by the
snapshots; a change to a type's shape (a field added to an options object, a
widened parameter) compiles clean against the snapshot and is semver-judged
at change time — shape changes that break consumers are treated as breaking,
but the judgment is human, not mechanical.

## Deep subpaths are internal

`@yevgetman/sov-sdk/*` deep subpaths (e.g.
`@yevgetman/sov-sdk/core/query.js`) **ship in the tarball but are internal
and unstable**. They exist so the private wrapper and its test suite can
reach every module. They carry **no semver coverage**: they may change shape,
move, or disappear in any release, including a patch. Bind only to the `.`
entry. `@yevgetman/sov-protocol` exposes no deep subpaths.

## The 0.x caveat

Both packages start at **0.1.0**. Under semver, 0.x minors are allowed to
break. **This project's actual intent:** the frozen export names are treated
as stable within 0.x — we do not remove or rename a `.` entry export in a
patch, and if a break is ever unavoidable before 1.0 it lands in a minor bump
with an explicit migration note in the changelog. Patch releases never break
the frozen surface.

## Injected `Settings`: by-reference, live-reconfiguration semantics

This note is about the runtime seam (`RuntimeOptions.settings` on the private
wrapper's `buildRuntime`, mirrored by the SDK's `AgentConfig.settings`), and
is part of the stability contract for anyone embedding against injected
configuration:

- The injected `Settings` object is held **by reference, not copied**. Every
  re-apply site reads *that object* again: the live-reload closures
  (`reresolveProvider` / `reloadHooks` / `reloadMcpServers` /
  `rebuildTaskRouting`), the scheduler's child-provider resolution, the
  per-turn webSearch source, and per-session construction.
- An **in-place mutation therefore becomes visible on the next reload / turn /
  session build.** That is intentional and IS the injected embed's
  live-reconfiguration mechanism: mutate the injected object, then fire the
  matching reload closure (e.g. set a new model, then `reresolveProvider()`).
  The closures re-apply the injected object instead of reading disk, so an
  injected-settings embed stays fully disk-free across reconfiguration.
- When settings are **omitted**, behavior is unchanged: config is read from
  disk at boot (and re-read by the reload paths).
- The SDK's `createAgent` consults `AgentConfig.settings` at each `run()`
  (provider resolution), following the same read-at-use-time pattern.

These semantics are locked; a future change to copy-on-inject would be a
breaking change to the embedding contract and versioned accordingly.
