# Sovereign AI SDK — consumable-package & publish-readiness design (2026-07-01)

> **Status: DRAFT — awaiting CEO green-light (SOP-12).** This is the follow-on to the full-inversion extraction (`specs/2026-06-29-sdk-open-core-extraction-design.md`, B-0014), which delivered the SDK as an *internal* architecture — merged to `master` 2026-06-30, boundary lint 0 open→proprietary, every surface running on `createAgent()`, but still **`private`/`UNLICENSED`, logical-only split, Bun-only, bare-`.ts` exports**. That spec explicitly deferred "publish/polish" (§13 / §170) and the CEO deferred the *physical* `packages/` move at Phase 8. **This spec closes exactly that deferred tail: turn the open core into a real, publishable, Node+Bun package any external app can `npm install` and consume — up to the point of publishing, then STOP.** Deferred-work catalog it discharges: `docs/08-roadmap/sdk-extraction-deferred-work.md` §1.2, §1.3, §1.5, §1.6 + the consumer-facing hardening in §2. Implementation plan (next): `plans/2026-07-01-sdk-consumable-packaging.md`.
>
> **Brainstorm decisions (Gene, 2026-07-01):** (1) **scope = both open packages** — the embeddable core `@yevgetman/sov-sdk` (flagship) + the wire client `@yevgetman/sov-protocol` (already built, near-free to package, the known next consumer's dep); (2) **runtime = Node + Bun** (compiled JS + `.d.ts`, no `bun:sqlite` in the open graph); (3) **license = MIT** on the open subset only; (4) **definition of done = publish-ready, CEO pushes the button** — build/verify/document to a publishable state, then STOP before the public `npm publish` and the repo-public flip (open-sourcing is irreversible). (5) **Approach = B (incremental strangler: protocol package first, then the core).**

## 1. Prime directives

1. **A true consumable SDK.** An external developer, in a fresh project on **Node or Bun**, can `npm install @yevgetman/sov-sdk`, `import { createAgent } from '@yevgetman/sov-sdk'`, and run an agent turn — with **no access to proprietary code, no `bun:sqlite`, no deep `src/` imports, no disk required**. Same for `@yevgetman/sov-protocol` (the typed gateway wire client). This is the property B-0014 delivered *logically* but not yet as a *shippable artifact*.
2. **Zero regression to the harness.** The proprietary wrapper `@yevgetman/sov` keeps every capability and the green gate throughout. The wrapper consumes the two open packages via workspace links; the boundary lint stays **0 open→proprietary** at every step.
3. **Publish-ready, not published.** The build ends with packed, versioned, documented, canary-green tarballs and a green `npm publish --dry-run` — and a publish runbook. It does **not** run the real publish or flip the repo public. That is a single, explicit, CEO-gated step afterward.
4. **YAGNI holds the line.** In scope: packaging, Node compat, barrel completeness, license, docs, the consumer-facing correctness hardening. **Out of scope:** the four proprietary subsystems (learning, gateway multi-tenancy, workflow engine, subscription-executor) stay closed; no plugin/agent marketplace; no bundle work beyond what Node-consumability forces; the resume-as-code migration itself (its trigger, not its execution).

## 2. Grounding (verified against HEAD `0bff267`, 2026-07-01)

**What already exists (B-0014 output):**
- `src/sdk.ts` — the Contract #1 barrel, **re-export-only**, classified OPEN so `bun run boundary` gates its imports. It *self-documents* the four surfaces still missing (see §5).
- `src/protocol/index.ts` — the Contract #2 barrel (`events` + `endpoints` + a fetch client), pure types + dependency-free client, pinned by `tests/protocol/surface.test.ts` + `surface.types.ts`.
- `examples/embed/embed.ts` — a no-disk embed canary that today imports deep `src/` paths (not a built package).
- `tests/sdk/barrel.test.ts` + `tests/sdk/surface.test.ts` — in-repo importability + a surface snapshot.
- `scripts/boundary-manifest.json` + `.dependency-cruiser.cjs` — the **file-level** open/proprietary partition (the machine-readable move-list for §7 Phase 3).

**What blocks external consumption (the gaps this spec closes):**
- `package.json` is `"private": true`, `"license": "UNLICENSED"`, `"engines": { "bun": ">=1.2.0" }` (no Node), and its `exports` are **bare `.ts`** (`"."→"./src/main.ts"`, `"./sdk"→"./src/sdk.ts"`, `"./protocol"→"./src/protocol/index.ts"`) — unconsumable by Node and unpublishable.
- **No `build`/`pack`/`publish` scripts, no `workspaces` field.** `packages/` contains only `tui` (the Go client); the `sdk`/`protocol` workspaces do not exist — the split is logical (boundary lint + exports map + snapshots) only.
- `zod` is a **root** dependency but is imported by an OPEN module (`src/core/observePort.ts`) — at split it must be declared a dependency of the *open* package.
- `tsconfig.json` is `noEmit: true`, `module: ESNext`, `moduleResolution: bundler`, `verbatimModuleSyntax: true`, and imports already carry **`.js` specifiers** — so a `tsc` emit to `.js` + `.d.ts` is aligned and clean; only the emit config + per-package `exports` conditions are missing.

**Confirmed good news:** the open dependency graph already excludes `bun:sqlite` (the in-memory `SessionStore` default + the port; the concrete `bun:sqlite` `SessionDb` is proprietary). The remaining Node-compat unknown is other Bun-specific APIs in the open set (e.g. `Bun.Glob` in `permissions/writeScope` + `runtime/pathLock`, `Bun.file`), audited in Phase 2.

## 3. Target end-state

```
  repo root  @yevgetman/sov  (private, UNLICENSED)  ── workspace root; the proprietary WRAPPER
    │  depends on ↓ via workspace:*                     (CLI · gateway · learning · workflows ·
    │                                                    subscription-executor · sessionDb impl)
    ├── packages/protocol   @yevgetman/sov-protocol  (MIT, published)  ── wire types + fetch client
    ├── packages/sdk        @yevgetman/sov-sdk        (MIT, published)  ── createAgent() + ports + core
    └── packages/tui        (Go client, unchanged)
```

Each open package ships **compiled `dist/*.js` + `dist/*.d.ts`** with a conditional `exports` map (`types`/`import`/`default`), a `files` allow-list (dist + LICENSE + README only — **no `.ts` source, no proprietary files**), its own semver line, an MIT `LICENSE`, and a README/quickstart. The wrapper depends on both via `workspace:*` and retargets its imports of open modules to the package names. `bun run lint && typecheck && test` and the boundary lint stay green throughout.

## 4. The two packages

- **`@yevgetman/sov-protocol`** (small, done-in-substance) — relocate `src/protocol/*`; it is already pure types + a dependency-free `fetch` client. Consumers (gateway server, Go TUI, and later resume-as-code) import the package name instead of `src/protocol`. This is the **machinery proof** (Phase 1): it validates the entire workspace + compiled-build + conditional-exports + Node/Bun tarball-canary + MIT + publish-dry-run pipeline on the lowest-risk surface before the big move.
- **`@yevgetman/sov-sdk`** (the flagship) — relocate the OPEN file set enumerated in `scripts/boundary-manifest.json` into `packages/sdk/src/`, retarget every proprietary import of an open module to `@yevgetman/sov-sdk`, and complete the public barrel (§5). `zod` becomes its declared dependency. This is the Anthropic-Agent-SDK-analog: the engine others build agents on.

## 5. SDK surface completeness (barrel, before the move)

`src/sdk.ts` already names the four surfaces omitted at B-0014 (`§1.6` of the deferred catalog); complete and then **freeze** them:
- **Delegation/scheduler:** export the `Scheduler` port (`delegate`, `agentNames`), `DelegateInput`/`DelegateResult`, the `runSubprocessExecutor` port types, and the pure `LaneRegistry` / `DelegationLifecycleEvent`.
- **Canonical tool descriptors:** author them in open core and refactor the subscription-executor to derive its tool-name/key mapping from them (removing the hardcoded `subprocessExecutor.ts:146-168` block), then re-export.
- **MCP pool/factory port:** define + export the hot-swappable pool/factory port so embedders (and the gateway's `reloadMcpServers`) obtain MCP tools through the SDK.
- **`buildToolScope`:** relocate it (+ its closure) out of proprietary `src/commands/toolScope.ts` into an open module, then export; re-verify the boundary stays green.

Freeze the result with an extended `tests/sdk/surface.test.ts` snapshot — this snapshot **is** the semver contract (§8).

## 6. Node compatibility

- **Emit:** a per-package `tsconfig.build.json` (`noEmit:false`, `declaration:true`, `outDir:"dist"`, `module`/`moduleResolution` set for `nodenext`-resolvable output). Source already uses `.js` specifiers + `verbatimModuleSyntax`, so emit is mechanical.
- **`exports` conditions:** each open `package.json` maps its public entries to `{ "types": "./dist/…d.ts", "import": "./dist/…js", "default": "./dist/…js" }` — replacing the bare-`.ts` root map.
- **Bun-API audit (Phase 2):** grep the OPEN file set for `Bun.*` / `bun:*`; each hit is either replaced with a cross-runtime equivalent or hidden behind a tiny injected abstraction. `bun:sqlite` is already absent from the open graph (asserted by the canary).
- **Declared deps:** `zod` (and any other runtime import) declared on `@yevgetman/sov-sdk`; the open packages must have **no dependency, npm or source, on proprietary code**.
- **Proof:** the external-consumer canary (§9) runs the built tarball under **both `node` and `bun`**.

## 7. Work breakdown (Approach B — incremental strangler)

0. **Monorepo scaffolding + build tooling.** Add `workspaces: ["packages/*"]` to the root; create the per-package build config + a repo-wide `build`/`pack` script pattern; wire `workspace:*`. No file moves yet — root still builds/tests green.
1. **Protocol package (machinery proof).** Relocate `src/protocol/*` → `packages/protocol/`; add MIT + README + conditional exports + compiled build; retarget the gateway/TUI/consumers to `@yevgetman/sov-protocol`; **exit gate: tarball-install canary green under Node + Bun**, `npm publish --dry-run` green.
2. **SDK surface completeness + Node-compat prep (no moves).** Complete the barrel (§5); audit + shim Bun-specific APIs in the open set (§6); declare open-package deps; freeze the target surface. Boundary + typecheck + test stay green.
3. **SDK core package (the big move).** Relocate the OPEN file set (driven by `boundary-manifest.json`) → `packages/sdk/src/`; retarget proprietary imports to `@yevgetman/sov-sdk`; MIT + README + conditional exports + compiled build. **Boundary lint 0 open→proprietary, typecheck, and the full suite green throughout; exit gate: tarball canary green under Node + Bun.**
4. **Consumer-facing correctness hardening** (deferred-catalog §2). Formalize the `createAgent.persistTurn` persistence contract + guard/test (a stable-`sessionId` embedder must not get duplicate rows); thread injected `settings` into the live-reload/scheduler disk-read paths for true no-disk self-containment; accumulate `usage_delta` across turns for correct multi-turn cost accounting.
5. **Publish-readiness + docs — then STOP.** README/quickstart + a written semver/stability policy per package; API docs/examples (promote `examples/embed`); an `npm pack` tarball-contents assertion (dist + LICENSE + README only); `npm publish --dry-run` green for both open packages; a `PUBLISHING.md` runbook. **Do not run the real publish or flip the repo public** — CEO's button.

## 8. Versioning & stability

Each open package starts its **own** semver line at **`0.1.0`** (a new public artifact, independent of the harness `0.6.x`). The frozen surface snapshots (Contract #1 in `tests/sdk/`, Contract #2 in `tests/protocol/`) are the semver contract: a breaking change to an exported symbol = a major bump + a migration note. The wrapper `@yevgetman/sov` is consumer #0 and catches breaks before any external app. A written `STABILITY.md` states what is covered (barrel exports) vs. internal (everything reachable only by deep path — which the published `files` allow-list omits anyway).

## 9. Acceptance criteria (the gate)

1. `bun run lint && typecheck && test` green — **no regressions**; boundary lint **0 open→proprietary** maintained.
2. Each open package **builds** (`tsc` emit → `dist/*.js` + `*.d.ts`) and **packs** (`npm pack`) to a tarball whose contents are dist + LICENSE + README **only** — asserted by a tarball-contents test (no `.ts` source, no proprietary module).
3. **External-consumer canary — the headline gate:** a scratch project installs `@yevgetman/sov-sdk` (and `@yevgetman/sov-protocol`) **from the packed tarball** (not source, not deep paths), imports via the public entry, and runs a **no-disk** agent turn against a mock/local provider — **passing under both `node` and `bun`**.
4. **No `bun:sqlite` and no proprietary module** in either open package's resolved dependency graph (canary + a dep-graph assertion).
5. **Frozen public-surface snapshots** for both packages pass (Contract #1 + #2).
6. `npm publish --dry-run` succeeds for both open packages; the `PUBLISHING.md` runbook exists. **The real publish + repo-public flip are NOT run.**
7. `sov upgrade` / the harness binary path is unaffected (the SDK ships via npm, not the `sov-releases` binary pipeline — see §11).

## 10. Scope

**In scope:** monorepo `packages/` split (protocol + sdk workspaces); compiled build + conditional `exports`; Node compatibility (emit, `exports` conditions, Bun-API audit/shims, declared deps); barrel completeness + surface freeze; MIT license on the open subset; README/quickstart/semver docs; the three consumer-facing correctness fixes (§7.4); the external-consumer canary + publish-dry-run + runbook.

**Out of scope (explicit):** the actual public `npm publish` and repo-public flip (CEO step, post-gate); the four proprietary subsystems; the resume-as-code migration *execution* (this build makes it *possible*; it is the next, separate build); a fresh binary release of the harness (§11); plugin/agent marketplace; bundle minimization beyond Node necessity; a multi-**repo** (vs multi-package) split.

## 11. Adjacent, deliberately separate: the harness release gap

Smoke-testing found that the installed `sov` binary is **v0.6.47 (pre-inversion)** and `sov upgrade` only pulls the latest *release tag* — and **no release was cut after the inversion** — so the binary cannot reach the SDK-inverted `master`. This is **orthogonal** to this spec: the SDK is consumed via **npm**, not the `sov-releases` binary pipeline. Flagged here so it is not lost; cutting a post-inversion harness release is a separate decision, tracked in the deferred-work catalog.

## 12. Risks & mitigations

- **The big import-retarget (Phase 3)** — a missed import / exports-gap breaks the build. → The move is **script-driven from `boundary-manifest.json`** (the classification is already done); the boundary lint + typecheck + full suite are the parity gate; **protocol-first (Phase 1) proves the machinery** on a small surface before the core moves.
- **Bun-specific APIs block Node** — → audited **before** the move (Phase 2); the Node canary is the proof, not an assumption.
- **Emit/resolution edge cases** (`moduleResolution: bundler` source → `nodenext` consumers) — → source already uses `.js` specifiers; the tarball canary under Node is the real-world check.
- **`workspace:*` vs published versions** — the wrapper links `workspace:*`; publish substitutes concrete versions. → covered by the `PUBLISHING.md` runbook + `npm pack`/`--dry-run` gates.
- **Scope creep into proprietary subsystems** — → §10 names them out; the boundary lint mechanically prevents an open package from importing them.
- **Accidental early publish** — → the DoD hard-stops at `--dry-run`; the real publish is a separate CEO-gated action with its own runbook.

## 13. Open decisions for the CEO (green-light gate)

1. **Ratify scope + Approach B** (both open packages; Node+Bun; MIT; publish-ready-you-push; incremental strangler, protocol-first) — §1/§7 as written.
2. **Monorepo layout:** the proprietary `@yevgetman/sov` **stays at repo root** as the wrapper (only open files move — *recommended*, minimizes churn, matches extraction-spec §12), **or** also moves into `packages/sov` (cleaner symmetry, far more churn). Recommendation: **stay at root**.
3. **Consumer-facing hardening (§7.4):** include in this build (*recommended* — the `persistTurn` duplicate-row issue is a real bug a stable-session embedder hits), or split to an immediate follow-up. Recommendation: **include**, with the `persistTurn` contract as the non-negotiable and the other two folded in if they stay bounded.
4. **Open-package start version:** independent **`0.1.0`** line (*recommended*) vs. mirroring the harness `0.6.x`.
