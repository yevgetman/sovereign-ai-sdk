# Consumable-Package & Publish-Readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the logically-split open core into two real, publishable, Node+Bun npm packages (`@yevgetman/sov-sdk` + `@yevgetman/sov-protocol`) that any external app can `npm install` and consume — up to publish-ready, then STOP before the actual publish.

**Architecture:** Bun monorepo. The repo root stays the private proprietary wrapper `@yevgetman/sov`; two new workspaces under `packages/` hold the open code, each emitting compiled `dist/*.js` + `*.d.ts` via `tsc`. The wrapper depends on both via `workspace:*` and imports them by package name (barrel `.` where covered, `./*` deep subpath otherwise). Approach B: build + prove the whole packaging pipeline on the small `protocol` package first, then relocate the ~141-file SDK core.

**Tech Stack:** TypeScript, Bun (workspaces + `bun publish`), `tsc` (nodenext emit), dependency-cruiser (boundary lint), Biome (lint/format), `npm pack`/`npm publish --dry-run` (packaging gates), Node ≥20 + Bun ≥1.2 (dual-runtime canary).

**Design spec:** `specs/2026-07-01-sdk-consumable-packaging-design.md` (B-0014 follow-on; CEO-green-lit 2026-07-01, defaults). **Predecessor:** `specs/2026-06-29-sdk-open-core-extraction-design.md`. **Move-list source of truth:** `scripts/boundary-manifest.json`.

## Global Constraints

Every task inherits these. Values are locked (spec + grounding).

- **GC-1 Green gate, always.** After every task: `bun run lint` (biome + boundary), `bun run typecheck`, `bun test` all green; **no regressions**. The boundary lint must report **0 open→proprietary**.
- **GC-2 Package identity.** Open packages: `@yevgetman/sov-sdk` + `@yevgetman/sov-protocol`, each `version: "0.1.0"`, `type: "module"`, `license: "MIT"`, `engines: { "node": ">=20", "bun": ">=1.2.0" }`, `files: ["dist","LICENSE","README.md"]`, **no** `private` field. Root wrapper `@yevgetman/sov` stays `"private": true`, `"license": "UNLICENSED"`.
- **GC-3 Exports.** `@yevgetman/sov-sdk` exposes `.` → `dist/sdk.js` (frozen public surface) **and** `"./*"` → `dist/*.js` (all modules; internal/unstable). `@yevgetman/sov-protocol` exposes only `.` → `dist/index.js`. All conditional: `{ "types": "./dist/…d.ts", "import": "./dist/…js", "default": "./dist/…js" }`.
- **GC-4 Emit.** Per-package `tsconfig.build.json` extends `../../tsconfig.json` and overrides `{ noEmit:false, declaration:true, module:"nodenext", moduleResolution:"nodenext", outDir:"dist", rootDir:"src" }`, `include:["src/**/*"]`, `exclude:["**/*.test.ts","dist","node_modules"]`. Source already uses `.js` specifiers + `verbatimModuleSyntax` → emit is mechanical.
- **GC-5 SDK runtime deps (six):** `zod`, `yaml`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `picomatch`, `tinyglobby` (pin versions from root `package.json`). Protocol runtime deps: **none**. Do **not** remove these from the wrapper's own deps (server/cli import them directly) until a proprietary-side scan confirms.
- **GC-6 No Bun globals in the open packages' runtime paths.** All `Bun.*`/`bun:*` in the OPEN set is shimmed (see Phase 2). A dep-graph/grep guard fails on any residual `Bun.`/`bun:` in shipped dist. `bun:sqlite` is already absent — keep it that way.
- **GC-7 Boundary lint rebased.** After files move, dependency-cruiser targets `packages/sdk/src` + `packages/protocol/src`; the manifest `^src/` anchors become `^packages/sdk/src/` / `^packages/protocol/src/`; the rule forbids any open-package file from importing the wrapper (`@yevgetman/sov` or root `src/`). Keep `tsPreCompilationDeps: true`.
- **GC-8 `sov --version` unchanged.** The wrapper reports the harness `0.6.x` line from its own version source; only the SDK's `version.ts` reports the SDK's `0.1.0`.
- **GC-9 DoD hard-stop.** The build ends at green `npm publish --dry-run` for both open packages + a `PUBLISHING.md` runbook. **Never** run the real `npm publish` or flip the repo public — that is a separate CEO action.
- **GC-10 Commit granularity.** One commit per task (conventional-commit prefix). No attribution trailer (repo convention).

## File Structure

**Created:**
- `packages/protocol/{package.json,tsconfig.build.json,LICENSE,README.md,src/**}` — `@yevgetman/sov-protocol` (moved from `src/protocol/`).
- `packages/sdk/{package.json,tsconfig.build.json,LICENSE,README.md,src/**}` — `@yevgetman/sov-sdk` (moved from the 141-file OPEN set).
- `packages/sdk/src/util/spawn.ts` — the cross-runtime `node:child_process` spawn shim (Phase 2).
- `packages/sdk/src/tool/descriptors.ts` — canonical tool descriptors (Phase 2).
- `packages/sdk/src/tool/toolScope.ts` — relocated from `src/commands/toolScope.ts` (Phase 2).
- `packages/sdk/src/core/usageAccumulator.ts` — cross-turn token accumulation (Phase 4, internal, not barrel-exported).
- `src/wrapperVersion.ts` — the wrapper's own version reader (Phase 3, GC-8).
- `scripts/canary/consumer.mjs` + `scripts/canary/run-consumer-canary.ts` — the external-consumer canary (Phase 5).
- `packages/{sdk,protocol}/tests/{surface,tarball}.test.ts` — relocated surface snapshots + tarball-contents assertions (Phases 1/5).
- `PUBLISHING.md` — the publish runbook (Phase 5).

**Modified:**
- root `package.json` — add `workspaces`, `workspace:*` deps, build/pack scripts; replace bare-`.ts` exports.
- root `tsconfig.json`, `.dependency-cruiser.cjs`, `scripts/boundary-manifest.json`, `biome.json`/script globs — extend to `packages/*`.
- `.github/workflows/ci.yml` — add build + node/bun canary + tarball + dry-run jobs.
- ~94 wrapper source files + ~250 test files — import retarget (Phase 3).
- `src/runtime/subprocessExecutor.ts` (derive from descriptors), `src/server/runtime.ts` (Fix-2 settings threading), `src/agent/createAgent.ts` (Fix-1/Fix-3 hardening), the 6 Bun.* files (shims).

## Progressive elaboration

Phases 0–1 are fully elaborated below (they are executed first). Phases 2–5 carry their locked task list, interfaces, and decisions; **elaborate each into bite-sized TDD steps immediately before executing it**, re-grounding line numbers against the then-current tree (they shift as files move).

---

## Phase 0 — Monorepo scaffolding + build tooling (no file moves)

**Deliverable:** the repo is a Bun workspace with an empty `packages/sdk` + `packages/protocol` skeleton that builds/typechecks/tests green; root still holds all source. No behavior change.

### Task 0.1: Add the workspace root + empty package skeletons

**Files:**
- Modify: `package.json` (add `workspaces`)
- Create: `packages/protocol/package.json`, `packages/sdk/package.json`

**Interfaces:**
- Produces: two workspace packages resolvable by name (empty `dist` for now); `workspaces: ["packages/sdk","packages/protocol"]` on root (explicit, to exclude the Go `packages/tui`).

- [ ] **Step 1:** Add `"workspaces": ["packages/sdk", "packages/protocol"]` to root `package.json`.
- [ ] **Step 2:** Create `packages/protocol/package.json`:

```json
{
  "name": "@yevgetman/sov-protocol",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20", "bun": ">=1.2.0" },
  "files": ["dist", "LICENSE", "README.md"],
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.build.json", "prepack": "bun run build" },
  "devDependencies": { "typescript": "^5" }
}
```

- [ ] **Step 3:** Create `packages/sdk/package.json` (deps per GC-5, exports per GC-3):

```json
{
  "name": "@yevgetman/sov-sdk",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20", "bun": ">=1.2.0" },
  "files": ["dist", "LICENSE", "README.md"],
  "exports": {
    ".": { "types": "./dist/sdk.d.ts", "import": "./dist/sdk.js", "default": "./dist/sdk.js" },
    "./*": { "types": "./dist/*.d.ts", "import": "./dist/*.js", "default": "./dist/*.js" }
  },
  "scripts": { "build": "tsc -p tsconfig.build.json", "prepack": "bun run build" },
  "dependencies": {
    "zod": "^3.24.0", "yaml": "^2", "@modelcontextprotocol/sdk": "^1", "@anthropic-ai/sdk": "^0",
    "picomatch": "^4", "tinyglobby": "^0.2"
  },
  "devDependencies": { "typescript": "^5", "@types/node": "^22", "@types/picomatch": "^3" }
}
```
(Pin exact ranges to the root `package.json` versions during elaboration.)

- [ ] **Step 4:** Add the wrapper's workspace deps to root `package.json` `dependencies`: `"@yevgetman/sov-sdk": "workspace:*"`, `"@yevgetman/sov-protocol": "workspace:*"`.
- [ ] **Step 5:** `bun install` — relinks the workspace. Expected: no errors; `node_modules/@yevgetman/sov-sdk` symlinks to `packages/sdk`.
- [ ] **Step 6:** `bun run typecheck && bun run lint && bun test` — all green (packages are empty, root unchanged).
- [ ] **Step 7:** Commit: `chore(sdk): scaffold packages/sdk + packages/protocol workspaces`.

### Task 0.2: Per-package build config + LICENSE + README stubs

**Files:**
- Create: `packages/{sdk,protocol}/tsconfig.build.json`, `packages/{sdk,protocol}/LICENSE`, `packages/{sdk,protocol}/README.md`

- [ ] **Step 1:** Create each `tsconfig.build.json` (GC-4):

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": false, "declaration": true, "module": "nodenext", "moduleResolution": "nodenext",
    "outDir": "dist", "rootDir": "src", "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "dist", "node_modules"]
}
```
(sdk adds `"bun-types"` to `types` only if a Bun global survives the Phase-2 audit; target is `["node"]`.)

- [ ] **Step 2:** Add MIT `LICENSE` (SPDX MIT text, copyright holder = the repo owner) to each package.
- [ ] **Step 3:** Add a stub `README.md` to each (title + one-line description + "docs to follow"; filled in Phase 5).
- [ ] **Step 4:** Add root scripts to `package.json`: `"build": "bun run --filter='@yevgetman/sov-*' build"`, `"build:sdk": "cd packages/sdk && bun run build"`, `"build:protocol": "cd packages/protocol && bun run build"`.
- [ ] **Step 5:** `bun run typecheck && bun run lint && bun test` — green. (No `src` in the packages yet, so `bun run build` is a no-op/near-empty; that is fine.)
- [ ] **Step 6:** Commit: `chore(sdk): per-package build config + MIT license + readme stubs`.

---

## Phase 1 — Protocol package (the machinery proof)

**Deliverable:** `@yevgetman/sov-protocol` is a real, built, packable package; the 5 server routes + 4 protocol tests import it by name; an install-from-tarball canary runs under **Node and Bun**; `npm publish --dry-run` is green. This validates the entire packaging pipeline on the smallest surface before the big move.

### Task 1.1: Move `src/protocol/` → `packages/protocol/src/`

**Files:**
- Move: `src/protocol/{events,endpoints,client,index}.ts` (+ any siblings) → `packages/protocol/src/`
- Modify: intra-protocol imports stay relative (`./events.js` etc. — no change needed)

**Interfaces:**
- Produces: `@yevgetman/sov-protocol` barrel = `packages/protocol/src/index.ts` (re-exports events/endpoints/client, unchanged).

- [ ] **Step 1:** `git mv src/protocol packages/protocol/src` (preserve history). Confirm intra-imports are all relative `./x.js` (grounding: index.ts:20-22, client.ts:29, endpoints.ts:16 — all relative, move as-is).
- [ ] **Step 2:** `cd packages/protocol && bun run build` — expect `dist/{index,events,endpoints,client}.js` + `.d.ts` emitted clean.
- [ ] **Step 3:** Verify no import errors; the package self-typechecks.
- [ ] **Step 4:** Commit: `refactor(protocol): relocate src/protocol into packages/protocol`.

### Task 1.2: Retarget the 5 server routes + 4 protocol tests to `@yevgetman/sov-protocol`

**Files:**
- Modify: `src/server/routes/{approvals.ts:14,cancel.ts:24,health.ts:5,sessions.ts:28,turns.ts:42}` (`../../protocol/index.js` → `@yevgetman/sov-protocol`)
- Move+Modify: `tests/protocol/{surface.test.ts,surface.types.ts,conformance.test.ts,client.test.ts}` → `packages/protocol/tests/` (retarget `../../src/protocol/index.js` → `@yevgetman/sov-protocol`)

- [ ] **Step 1:** Rewrite the 5 route imports to the package name. Run `bun run typecheck` — green.
- [ ] **Step 2:** `git mv tests/protocol packages/protocol/tests`; retarget their imports to `@yevgetman/sov-protocol`.
- [ ] **Step 3:** Ensure `bun test` discovers `packages/protocol/tests` (bunfig `root="."` already discovers all `*.test.ts`). Run the protocol tests — green.
- [ ] **Step 4:** `bun run lint && typecheck && test` — full green (GC-1).
- [ ] **Step 5:** Commit: `refactor(protocol): retarget server routes + tests to @yevgetman/sov-protocol`.

### Task 1.3: Tarball-contents assertion for protocol

**Files:**
- Create: `packages/protocol/tests/tarball.test.ts`

**Interfaces:**
- Consumes: `npm pack --json` output (`.files[].path`, `.entryCount`).
- Produces: a test asserting the packed tarball = exactly `dist/**.{js,d.ts}` + `LICENSE` + `README.md`, **no** `.ts` source.

- [ ] **Step 1: Write the failing test** — run `npm pack --json --dry-run` in `packages/protocol`, parse the JSON, assert every `files[].path` matches `^(dist/.*\.(js|d\.ts)|LICENSE|README\.md|package\.json)$` and none ends in `src/` or `.ts` (excluding `.d.ts`).

```ts
import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
test('protocol tarball ships only dist + license + readme', () => {
  const out = execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: import.meta.dir + '/..' })
  const paths: string[] = JSON.parse(out.toString())[0].files.map((f: any) => f.path)
  const bad = paths.filter(p => !/^(dist\/.*\.(js|d\.ts)|LICENSE|README\.md|package\.json)$/.test(p))
  expect(bad).toEqual([])
})
```

- [ ] **Step 2:** Run it — expect PASS (Task 0.2 set `files`, Task 1.1 built dist). If it fails, fix the `files` allow-list.
- [ ] **Step 3:** Commit: `test(protocol): assert tarball contents are dist+license+readme only`.

### Task 1.4: External-consumer canary (protocol) under Node + Bun

**Files:**
- Create: `scripts/canary/run-consumer-canary.ts` (scratch-project generator — reused/extended for the SDK in Phase 5)
- Create: `scripts/canary/protocol-consumer.mjs` (runtime-agnostic consumer)

**Interfaces:**
- Produces: a script that `npm pack`s the protocol package, installs the tarball into a `mkdtemp` scratch project, and runs `protocol-consumer.mjs` under **both** `node` and `bun`, asserting a public import + a trivial use (e.g. `PROTOCOL_PATHS` present, `createSession`/`streamEvents` are functions) with `node:assert`; `process.exit(1)` on failure. **No `bun:test`, no `import.meta.main`.**

- [ ] **Step 1:** Write `protocol-consumer.mjs`: `import { PROTOCOL_PATHS, createSession, streamEvents } from '@yevgetman/sov-protocol'`; `assert(typeof createSession === 'function')`; print `PROTOCOL_OK`.
- [ ] **Step 2:** Write `run-consumer-canary.ts`: mkdtemp; write a minimal `package.json`; `npm pack` protocol → tarball; `npm install <tarball>`; run `node protocol-consumer.mjs` then `bun protocol-consumer.mjs`; assert both print `PROTOCOL_OK`, else exit 1.
- [ ] **Step 3:** Run `bun scripts/canary/run-consumer-canary.ts` — expect both runtimes green.
- [ ] **Step 4:** `npm publish --dry-run` in `packages/protocol` — expect success (no auth needed for dry-run).
- [ ] **Step 5:** Commit: `test(protocol): external-consumer canary (node+bun) + publish dry-run`.

### Task 1.5: Rebase the boundary lint for the protocol move + wire CI

**Files:**
- Modify: `scripts/boundary-manifest.json` (protocol paths → `^packages/protocol/src/`), `.dependency-cruiser.cjs` (target), root `package.json` `boundary` script, `.github/workflows/ci.yml`

- [ ] **Step 1:** Update the manifest + depcruise so the boundary rule also covers `packages/protocol/src` and forbids it importing the wrapper. Run `bun run boundary` — green (protocol has zero deps, trivially clean).
- [ ] **Step 2:** Add a CI job to `ci.yml` (push/PR): build the protocol package, run its tarball + surface tests, run the node+bun canary (add `actions/setup-node@v4` alongside `oven-sh/setup-bun`), `npm publish --dry-run`.
- [ ] **Step 3:** `bun run lint && typecheck && test` — green.
- [ ] **Step 4:** Commit: `ci(protocol): rebase boundary lint + add build/canary/dry-run jobs`.

**Phase-1 gate:** protocol is a fully consumable package proven under Node+Bun from a tarball; the pipeline (workspace → build → pack → install → dual-runtime canary → dry-run → CI) is validated end to end. The SDK core (Phase 3) reuses all of it.

---

## Phase 2 — SDK surface completeness + Node-compat prep (no file moves)

**Deliverable:** the `src/sdk.ts` barrel is complete + frozen, and every Bun-specific API in the OPEN set is shimmed — all while files are still at `src/`, so the existing test suite validates it in place. **Elaborate to TDD steps at execution; line numbers below are HEAD-verified and will drift.**

**Tasks (each: test-first, GC-1 green, one commit):**

- **2.1 Spawn shim.** Create `src/util/spawn.ts` exporting `spawn(argv, opts): SpawnedProc` (the existing shape at `executorPort.ts:21-36`) backed by `node:child_process.spawn` with `{cwd, signal}`, mapping `child.stdout`/`stderr` → Web `ReadableStream<Uint8Array>` via `Readable.toWeb()`, `exited: Promise<number>` from the `close` event, `stdin.write/end`, `kill`. Retarget the 5 sites (`hooks/runner.ts:206`, `skills/loader.ts:392`, `tools/GrepTool.ts:112`, `tools/BashTool.ts:361`, `tools/StaticSiteValidateTool.ts:188`) + the 2 `ReturnType<typeof Bun.spawn>` refs (`runner.ts:204`, `GrepTool.ts:110` → `SpawnedProc`). **Reader helpers (`readCapped`/`new Response(proc.stdout)`) stay unchanged** (they consume Web streams). Tests: spawn a real `echo`, assert captured stdout + exit code, under both runtimes.
- **2.2 Glob shims.** Replace `Bun.Glob(glob).match(rel)` (`permissions/writeScope.ts:48`, **security-relevant**) with `picomatch(glob)(rel)`; replace `Bun.Glob(pat).scanSync({cwd,onlyFiles})` (`tools/GlobTool.ts:54,60`) with `tinyglobby` (`globSync(pat,{cwd,onlyFiles:true})`). **Parity tests** on the existing writeScope/GlobTool fixtures (dotfiles, `**`, trailing slash) — a matcher wider than `Bun.Glob` would widen a write-permission gate.
- **2.3 StaticSiteValidateTool.** Rewrite `Bun.serve({port:0,fetch})` → `node:http.createServer((req,res)=>…)` + `server.listen(0)` + `server.address().port`; `new Response(Bun.file(t))` → `fs.createReadStream(t).pipe(res)`; `server.stop(true)` → `server.close()`. Keep client-side `fetch` (Node 18+ global). Test: validate a fixture static site, assert pass/fail unchanged.
- **2.4 Bun-residual guard.** Add a test that greps the OPEN file set for `\bBun\.` / `from ['"]bun` and fails on any hit (comments allowed to be swept in 2.5). Confirms `bun:sqlite` still absent.
- **2.5 Delegation/scheduler exports.** In `src/sdk.ts`: define + export a narrow `export interface Scheduler { delegate(i: DelegateInput): Promise<DelegateResult>; agentNames(): string[] }`; `export { SubagentScheduler }` + `export type { SubagentSchedulerOpts, DelegateInput, DelegateResult }` from `./runtime/scheduler.js`; `export type { RunSubprocessExecutor, RunSubprocessExecutorOpts, SubprocessExecutorResult, SpawnFn, SpawnedProc, SpawnOpts, LearningSink, TraceSink }` from `./runtime/executorPort.js`; `export type { LaneRegistry, DelegationLifecycleEvent }` from `./tool/ports.js`. All already OPEN — no manifest edit.
- **2.6 Canonical tool descriptors.** Author OPEN `src/tool/descriptors.ts` encoding, per tool, `{ name, aliases, inputKeyRenames, inputKeysToDrop }` — **lossless** vs `subprocessExecutor.ts:101-123` (the 3 rule kinds: `CLAUDE_TO_NATIVE_TOOL_NAME`, `INPUT_KEY_RENAMES`, `INPUT_KEYS_TO_DROP`). Refactor `subprocessExecutor.ts:135-159` (`canonicalizeToolForObservation`) to derive from it. Re-export descriptors from `sdk.ts`. Test: the derived maps equal the old hardcoded constants exactly.
- **2.7 MCP factory port.** Add `export type McpClientPoolFactory = (opts: BuildMcpClientPoolOpts) => Promise<McpClientPool>` to OPEN `src/mcp/types.ts`; re-export from `sdk.ts` (building blocks already exported). Swap logic stays proprietary.
- **2.8 Relocate `buildToolScope`.** `git mv src/commands/toolScope.ts src/tool/toolScope.ts` (auto-OPEN, zero manifest edit); update the 2 importers (`server/routes/turns.ts:25`, `cli/missionRun.ts:15`); `export { buildToolScope }` + `export type { ToolScope }` from `sdk.ts`. All its deps already OPEN → boundary green.
- **2.9 Freeze the surface.** Extend `tests/sdk/surface.test.ts` `EXPECTED_VALUE_EXPORTS` + `TypeSurfaceWitness` to the completed set (this snapshot = the 0.1.0 semver contract, spec §8). `shouldFireReviewOnDelegation` stays **out** of the public surface.

**Phase-2 gate:** `sdk.ts` is complete + frozen; the Bun-residual guard is green; full suite green — all with files still at `src/`.

---

## Phase 3 — SDK core package (the big move)

**Deliverable:** the 141-file OPEN set lives in `packages/sdk/src/`, the wrapper imports it by package name, everything builds/typechecks/tests green, and the SDK's install-from-tarball canary passes under Node+Bun. **This is the highest-risk phase — the move is script-driven from `boundary-manifest.json` and gated by the boundary lint + full suite. Elaborate carefully at execution.**

**Tasks:**

- **3.1 Wrapper version source (GC-8).** Create `src/wrapperVersion.ts` reading the root `package.json` version; retarget `src/main.ts:30`, `cli/configMode.ts:158`, `cli/tuiLauncher.ts:307` to it (so `sov --version` stays `0.6.x` after `version.ts` moves). Test: `sov --version` prints the wrapper version.
- **3.2 Scripted move.** From `boundary-manifest.json`: `git mv` the 17 openFullyDirs' contents (minus `protocol`, already moved) + the openSplitDir OPEN files + the 3 openFilesInProprietaryDirs (`agent/createAgent.ts`, `router/capabilities.ts`, `commands/types.ts`) + `version.ts` + `sdk.ts` into `packages/sdk/src/`, preserving subtree paths. Intra-SDK relative imports move unchanged.
- **3.3 Retarget wrapper imports.** Mechanical rewrite (script + review) of the ~345 prop→open edges across ~94 wrapper files: relative `../<dir>/<file>.js` whose target is an OPEN module → `@yevgetman/sov-sdk` (if every imported symbol is a barrel export) else `@yevgetman/sov-sdk/<dir>/<file>.js` (the `./*` wildcard). Symbol-aware (25 barrel-source modules still leak un-exported symbols — e.g. `commands/types.ts` exports only `PromptCommand` via barrel but the wrapper pulls `CommandContext`+6 more → use the subpath). `bun run typecheck` is the gate.
- **3.4 Retarget tests.** Move `tests/sdk/*` → `packages/sdk/tests/` (retarget to package name); retarget the ~250 root tests' deep `../../src/<open>` imports to `@yevgetman/sov-sdk/<subpath>` (same prefix rule).
- **3.5 Build config + deps finalize.** Ensure `packages/sdk/package.json` deps (GC-5) are complete; `cd packages/sdk && bun run build` emits clean `dist`. Fix `version.ts`'s `../package.json` resolution (now the SDK's own).
- **3.6 Rebase boundary lint (GC-7).** Repoint depcruise + manifest to `^packages/sdk/src/`; add the structural rule (open packages must not import `@yevgetman/sov`/root `src`). `bun run boundary` — **0 open→proprietary**.
- **3.7 SDK tarball + dual-runtime canary.** Extend `run-consumer-canary.ts` to also pack+install `@yevgetman/sov-sdk` (+ `zod`) and run an SDK consumer `.mjs` (own `echoProvider` mock ported from `examples/embed/embed.ts:44-85`, `createInMemorySessionStore`, one no-disk turn, `node:assert`) under Node+Bun. Add the built-artifact no-sqlite/no-proprietary dep-graph assertion against `dist`.
- **3.8 Full gate.** `bun run lint && typecheck && test` + both canaries green; commit.

**Phase-3 gate:** `import { createAgent } from '@yevgetman/sov-sdk'` runs a no-disk turn from an installed tarball under Node and Bun; the wrapper is green on the package; boundary structurally + lint-enforced.

---

## Phase 4 — Consumer-facing correctness hardening

**Deliverable:** the three embedder-facing correctness fixes (deferred-catalog §2), each test-first. Operates on the moved `packages/sdk/src/agent/createAgent.ts` (Fix 1/3) + the wrapper `src/server/runtime.ts` (Fix 2).

- **4.1 Fix 1 — persistTurn dedup (non-negotiable, spec §13.3).** In `packages/sdk/src/agent/createAgent.ts:380-423`, persist only messages **appended during this run** (track `seedMessages.length` from `:172-176`; save from that index in the loop at `:410-418`) so a stable-`sessionId` embedder that rehydrates history into `input` does not duplicate rows. Document the contract in the file header. Test (extend `tests/agent/createAgent.test.ts:282-313`): two `run()`s, stable sessionId + one `createInMemorySessionStore`, run 2 seeds with rehydrated history → assert no duplicate rows + `inputTokens` not double-counted.
- **4.2 Fix 3 — token accumulation.** Create internal OPEN `packages/sdk/src/core/usageAccumulator.ts` (NOT barrel-exported) implementing last-seen-per-call-then-sum across the tool loop (per `openai/streaming/chunks.ts:246-253` model, re-implemented — chunks.ts is proprietary), including cache-read/creation fields. Replace `createAgent.ts:255/:273` latest-snapshot capture; pass the summed `TokenUsage` to `persistTurn` at `:309`. Test: a multi-call tool-loop fixture (augment `echoToolUseTurn` with `usage_delta`s) → assert `recordTokenUsage` got the SUM.
- **4.3 Fix 2 — config injection (wrapper).** Thread the boot-resolved `opts.settings` into the 5 disk-read sites in `src/server/runtime.ts` (scheduler `:1368`, `reresolveProvider` `:1635/:1646/:1649/:1697-1701`, `reloadHooks` `:1741`, `reloadMcpServers` `:1765/:1783`, `rebuildTaskRouting` `:1555`) via the existing `...(opts.settings !== undefined ? { settings } : {})` spread — so an injected-settings embed never re-reads disk, and the no-injection path stays byte-identical. Test (extend `tests/config/settingsInjection.test.ts`): an injected-settings runtime that delegates a sub-agent + fires each reload closure asserts disk is never read.

**Phase-4 gate:** full suite green + the three new hardening tests; the no-injection/existing-surface behavior unchanged (channels/gateway/cron/OpenAI still pass no `sessionStore` — do not alter).

---

## Phase 5 — Publish-readiness + docs (STOP before publish)

**Deliverable:** both packages are documented, versioned, tarball-verified, and `npm publish --dry-run`-green, with a runbook — then the build **stops** (GC-9).

- **5.1 SDK tarball + built-artifact assertions.** Add `packages/sdk/tests/tarball.test.ts` (mirror Task 1.3) + confirm the Phase-3.7 no-sqlite/no-proprietary dep-graph check on `dist`.
- **5.2 READMEs + quickstart.** Fill `packages/{sdk,protocol}/README.md`: install, a `createAgent` quickstart (promote `examples/embed/embed.ts`, retargeted to `@yevgetman/sov-sdk` + an `examples/package.json` making it a real install-consumer), the public surface, and a Node/Bun compat note (embedders on Node <18 must inject `fetchImpl`).
- **5.3 STABILITY.md (semver policy).** State: public API = the `.` barrel (semver'd); `./*` deep subpaths = shipped-but-internal/unstable; breaking a barrel export = major bump. One per package (or a shared root `STABILITY.md` covering both).
- **5.4 PUBLISHING.md runbook.** The exact publish sequence (version bump, `bun run build`, `npm pack` inspect, `npm publish --access public` for each open package, tag), the `workspace:*` → concrete-version rewrite note (use the correct tool), and the repo-public-flip checklist — **as documentation only**.
- **5.5 CI finalize.** `ci.yml` builds both packages, runs surface + tarball tests, the node+bun canary matrix, and `npm publish --dry-run` for both — on every push/PR.
- **5.6 Dry-run + STOP.** `npm publish --dry-run` green for both open packages. **Do not publish. Do not flip the repo public.** Report publish-ready to the CEO.

**Phase-5 gate (DoD):** a scratch project installs the packed tarball and runs a no-disk turn under Node **and** Bun; tarballs contain only dist+LICENSE+README; surfaces frozen; `npm publish --dry-run` green; runbook written. Publish button un-pressed.

---

## Self-Review

- **Spec coverage:** §3 target ← Phase 0/3; §4 two packages ← Phase 1/3; §5 barrel ← Phase 2.5-2.9; §6 Node compat ← Phase 2.1-2.4 + GC-4/5; §7.1 protocol ← Phase 1; §7.2 completeness+prep ← Phase 2; §7.3 core move ← Phase 3; §7.4 hardening ← Phase 4; §7.5 publish-ready ← Phase 5; §8 versioning ← GC-2 + 5.3; §9 acceptance ← 1.3/1.4/3.7/5.1/5.6; §10 scope ← honored (proprietary subsystems untouched; no real publish); §11 release gap ← out of scope (noted); §13 CEO decisions ← all four defaults locked in GC/deps/Phase-3.1. **Covered.**
- **Placeholder scan:** later-phase tasks carry locked decisions + HEAD-verified line numbers but are intentionally not step-expanded (progressive elaboration, per the predecessor plan's house style) — elaborate immediately before executing each. No "TBD"/"add error handling"-style gaps in Phase 0-1 (the executed-first phases).
- **Type consistency:** `SpawnedProc`/`SpawnFn` reused from `executorPort.ts` throughout (2.1/3.x); `Scheduler` port defined once (2.5); `McpClientPoolFactory` defined once (2.7); `ToolScope` moved not renamed (2.8); `usageAccumulator` internal, not on the frozen surface (4.2). Consistent.
