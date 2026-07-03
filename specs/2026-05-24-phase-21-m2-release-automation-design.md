# Phase 21 M2 — Release automation design

**Date:** 2026-05-24
**Status:** Approved. Backlog item `#48` from `docs/08-roadmap/backlog/post-phase-13-4.md`.
**Predecessor:** Phase 21 M1 (`docs/07-history/state/2026-05-22-phase-21-m1.md`) — manual release pipeline at `scripts/release.ts`. Two releases shipped this way (v0.2.0 + v0.2.1). The manual cut is ~3 minutes of compile + ~30 seconds of upload, fronted by an editable `package.json` bump and a `git commit`. M2 lifts the compile + upload into GitHub Actions so the human path shrinks to `bump → commit → tag → push`.
**Driver:** Manual `bun run release v0.x.y` has accumulated enough friction (must be on a clean tree, on master, with `SOV_RELEASES_PATH` set, with `gh` authed against `sov-releases`) that automating it is now a higher-value move than any other backlog item. Per `#48` close-out trigger — "when manual releases start feeling like friction" — that point has arrived.

## 1. Purpose

Move the release pipeline from the author's laptop into GitHub Actions. Tagging a commit `vMAJOR.MINOR.PATCH` and pushing the tag becomes the entire release ceremony. The workflow compiles per-platform binaries, generates `SHA256SUMS`, and uploads everything to `yevgetman/sov-releases` as a tagged GitHub release. Beta users' install surface (`curl … install.sh | bash`) is unchanged.

**Out of scope for M2:**
- macOS code-signing + notarization. Requires Apple Developer Program enrollment (~$99/yr) and an App Store Connect API key. Triggered when the author chooses to enroll, in a separate session.
- Homebrew tap. No beta user has asked for `brew install`; gated on actual demand.
- Windows / linux-arm64 / Alpine targets. Phase 21 follow-ups; orthogonal to automation.
- Auto-version-bumping. The human still owns the `package.json` edit + commit; CI only consumes the resulting tag. Version bump magic is a YAGNI footgun.
- Auto-generated release notes from `git log`. The author maintains `CHANGELOG.md` in `sov-releases` by hand; CI consumes it.

## 2. Scope

**In scope:**

1. New workflow at `.github/workflows/release.yml` in `sovereign-ai-sdk` — three sequential job stages with a parallel build stage.
2. Refactor of `scripts/release.ts` into three composable pieces under `scripts/`:
   - `scripts/release-shared.ts` — `TARGETS`, types, `run`/`capture`/`sha256`/`note`/`die` utilities
   - `scripts/release-build-target.ts <target> <version>` — single-target compile + tar
   - `scripts/release-upload.ts <version> [--dry-run]` — SHA256SUMS + `gh release create`
   - `scripts/release.ts` — kept as the local-orchestrator entry point; calls the two extracted scripts in sequence + retains local-only pre-flight (clean tree, on master, version mismatch, tag-and-push)
3. Fine-grained Personal Access Token scoped to `yevgetman/sov-releases` only with `Contents: read & write`, stored as repository secret `SOV_RELEASES_TOKEN` in `sovereign-ai-sdk`.
4. New `package.json` scripts: `release:build` and `release:upload` (per-step entry points; both local and CI use these).
5. Update to `docs/05-conventions/cutting-releases.md` documenting the new tag-push-driven flow + the local fallback.
6. New state snapshot at `docs/07-history/state/YYYY-MM-DD-phase-21-m2.md` once shipped.
7. One ADR in `DECISIONS.md` covering the cross-repo upload token model (P21-C).
8. Close backlog `#48` in `docs/08-roadmap/backlog/post-phase-13-4.md`.

**Out of scope (also already listed in §1, repeated here for emphasis):** signing, notarization, brew, additional targets, auto-bump, auto-notes.

## 3. Design decisions (ADRs)

### ADR P21-C — Cross-repo upload via fine-grained PAT scoped to `sov-releases`

The release workflow runs in `sovereign-ai-sdk` (private) but writes releases to `sov-releases` (public). The default `GITHUB_TOKEN` is scoped to the running workflow's own repo, so it cannot write to the public one.

**Options considered:**

- **GitHub App installation** — most-locked-down, but adds a layer of indirection (app secrets, installation token rotation) for a one-off cross-repo write. Overkill for a single-author single-target use case.
- **Classic PAT with `repo` scope** — works, but grants full read/write across every repo the author owns. Blast radius far exceeds need.
- **Fine-grained PAT scoped to `sov-releases` only with `Contents: read & write`** *(chosen)* — narrowest possible scope. Compromises in expiration management (max 1 year), which is acceptable for an author-owned secret.

The PAT is stored as `SOV_RELEASES_TOKEN` repository secret in `sovereign-ai-sdk`. Only the final `release` job exports it as `GH_TOKEN`, and only for the single `gh release create` invocation; nothing else in the workflow has access.

### ADR P21-D — Trigger on tag push + `workflow_dispatch`; not on push-to-master

Push-to-master is dangerous as a release trigger (every merge would cut a release). Manual-only via `workflow_dispatch` works but defeats the point of automation.

**Chosen:** primary trigger is `push: tags: ['v*.*.*']`. Secondary trigger is `workflow_dispatch` with a `version` input (string) + a `dry-run` input (boolean, default false), so a failed cut can be re-driven from the Actions UI without re-tagging.

`concurrency: { group: release-${{ github.ref_name }}, cancel-in-progress: false }` prevents the dispatch + tag-push variants from racing each other on the same version.

### ADR P21-E — Matrix runner: `macos-14` + `ubuntu-22.04` (2 jobs), not single-runner cross-compile

Bun + Go both support cross-compilation, so one Linux runner could theoretically produce all three targets. Two reasons to use a matrix instead:

1. **Risk parity with M1.** The local cuts that shipped v0.2.0 + v0.2.1 ran on darwin-arm64 and cross-compiled to the x64 + linux-x64 targets. `macos-14` is Apple Silicon (arm64-darwin host); using it preserves the *exact* host-target relationship that's already proven. Cross-from-Linux-to-darwin-arm64 is unvalidated in this repo; debugging it would add session time M2 isn't budgeted for.
2. **Native validation.** Each platform's binary gets a `--version` smoke on a matching native host before upload. The darwin-x64 cross-compiled binary remains unsmoked at this stage (cross from arm64; Rosetta is available on `macos-14` but we don't depend on it); first-Intel-Mac-beta-user remains the field validation point as it was in M1.

Cost: macOS runners are 10× billable on private repos. Estimated ~30–50 billable minutes per release. Acceptable for the author's release cadence; the alternative (cross-compile risk + opaque failure modes) is worse than the dollar cost.

### ADR P21-F — Three-stage workflow with extracted scripts

The workflow has four jobs: `preflight`, `build-darwin`, `build-linux`, `release`. The two `build-*` jobs run in parallel after `preflight`; `release` waits for both.

Rather than embed the build/upload logic inline in the YAML, three short Bun scripts are extracted from the existing `release.ts`. The workflow YAML is then ~80 lines of orchestration; the actual logic lives in TypeScript that's testable, reusable, and shared with the local-orchestrator path.

The local `bun run release v0.x.y` flow continues to work end-to-end (refactored to call the extracted scripts) — so CI being down doesn't block release-cutting.

### ADR P21-G — `scripts/release.ts` stays as the local-orchestrator entry point

After the refactor, `scripts/release.ts` is a thin coordinator:

1. Local-only pre-flight: clean tree, on master, package.json version matches arg, gh auth, Bun/Go versions, `SOV_RELEASES_PATH` set.
2. Loop `release-build-target.ts` per target (sequential locally; CI parallelizes via jobs instead).
3. Run `release-upload.ts` (which handles SHA256SUMS + `gh release create`).
4. Tag-and-push the private repo (which itself fires the CI workflow if the user wants to also see CI run for the same tag — idempotent because the workflow's first action is to check if the release already exists; see §6).

The CI workflow does NOT invoke `release.ts` (which would re-run all the local-only pre-flight). CI calls `release-build-target.ts` + `release-upload.ts` directly. This keeps a clean line between "things the author does on their laptop" and "things CI does on a fresh runner."

## 4. Workflow architecture

### 4.1 File location

`.github/workflows/release.yml` in the `sovereign-ai-sdk` repo. No `.github/` directory exists yet; this is the first workflow.

### 4.2 Job graph

```
on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      version:    { type: string,  required: true }
      dry-run:    { type: boolean, required: false, default: false }

concurrency:
  group: release-${{ github.event.inputs.version || github.ref_name }}
  cancel-in-progress: false

jobs:
  preflight:           ubuntu-22.04
  build-darwin:        macos-14   (needs: preflight)
  build-linux:         ubuntu-22.04 (needs: preflight)
  release:             ubuntu-22.04 (needs: [build-darwin, build-linux])
```

### 4.3 Job details

**`preflight`** (~2 min)
- `actions/checkout@v4` at the tagged ref
- `oven-sh/setup-bun@v2` (Bun ≥1.2)
- `bun install --frozen-lockfile`
- `bun run lint && bun run typecheck && bun run test`
- Assert `jq -r .version package.json` equals the version stripped of leading `v` (e.g., tag `v0.3.0` ↔ package.json `"0.3.0"`). Mismatch → exit 1 with a clear message.

**`build-darwin`** (~5 min, runs on `macos-14`)
- `actions/checkout@v4` of `sovereign-ai-sdk` at tag (default `path: .`)
- `actions/checkout@v4` of `yevgetman/sov-releases` at `main` with `path: sov-releases` and `token: ${{ secrets.SOV_RELEASES_TOKEN }}` (the PAT has `Contents: read` on the public repo, which is sufficient for clone)
- Export `SOV_RELEASES_PATH=$GITHUB_WORKSPACE/sov-releases`
- Setup Bun (≥1.2) + Go (≥1.24)
- `bun install --frozen-lockfile`
- `bun run release:build darwin-arm64 ${VERSION}` (writes `build/release/${VERSION}/sov-darwin-arm64.tar.gz`)
- `bun run release:build darwin-x64 ${VERSION}` (writes `build/release/${VERSION}/sov-darwin-x64.tar.gz`)
- Native smoke: `./build/release/${VERSION}/darwin-arm64/bin/sov --version` matches version
- `actions/upload-artifact@v4` with both tarballs (name: `tarballs-darwin`, path: `build/release/${VERSION}/sov-darwin-*.tar.gz`)

**`build-linux`** (~3 min, runs on `ubuntu-22.04`, parallel with darwin job)
- Same shape; native smoke for `linux-x64`
- Upload artifact (name: `tarballs-linux`, path: `build/release/${VERSION}/sov-linux-x64.tar.gz`)

**`release`** (~30s, runs on `ubuntu-22.04`)
- `actions/checkout@v4` of `sovereign-ai-sdk` at tag (for `scripts/`)
- `actions/checkout@v4` of `yevgetman/sov-releases` with `path: sov-releases` (for `CHANGELOG.md`); export `SOV_RELEASES_PATH=$GITHUB_WORKSPACE/sov-releases`
- `actions/download-artifact@v4` with `pattern: tarballs-*`, `merge-multiple: true`, `path: build/release/${VERSION}/`
- Setup Bun (the release-upload script is Bun-based)
- `bun install --frozen-lockfile`
- Step env: `GH_TOKEN: ${{ secrets.SOV_RELEASES_TOKEN }}`
- `bun run release:upload ${VERSION}` (with `--dry-run` if the workflow_dispatch dry-run input is true)

### 4.4 `package.json` script additions

```jsonc
{
  "scripts": {
    "release": "bun scripts/release.ts",
    "release:build": "bun scripts/release-build-target.ts",
    "release:upload": "bun scripts/release-upload.ts"
  }
}
```

The two new scripts are the entry points CI uses; the existing `release` script remains the local entry point.

## 5. Script refactor

### 5.1 `scripts/release-shared.ts` (new, ~80 lines)

Exports:

```typescript
export type TargetName = 'darwin-arm64' | 'darwin-x64' | 'linux-x64';

export interface Target {
  name: TargetName;
  bunTarget: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-x64';
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
}

export const TARGETS: readonly Target[];

export const OWNER = 'yevgetman';
export const PUBLIC_REPO = 'sov-releases';

export function die(msg: string): never;
export function note(msg: string): void;
export function run(bin: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): void;
export function capture(bin: string, args: string[], opts?: { cwd?: string }): string;
export function sha256(path: string): string;
export function satisfies(have: string, need: string): boolean;
export function repoRoot(): string;  // resolves to the harness repo root
```

Pure utilities lifted verbatim from current `scripts/release.ts`. No behavior change.

### 5.2 `scripts/release-build-target.ts` (new, ~100 lines)

```typescript
// Usage: bun scripts/release-build-target.ts <target> <version>
//
// Compiles sov + sov-tui for <target>, copies bundle-default + LICENSE
// + README + version, tars to build/release/<version>/sov-<target>.tar.gz.
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for LICENSE.txt)
```

Body is `buildOne()` from current `release.ts` lifted out, with arg parsing + target lookup + version validation moved from the caller.

Pre-flight in this script: only validates `<target>` is a known target name and `SOV_RELEASES_PATH/LICENSE.txt` exists. The script does NOT check git status, branch, or test gates — those are the local-orchestrator's job.

### 5.3 `scripts/release-upload.ts` (new, ~60 lines)

```typescript
// Usage: bun scripts/release-upload.ts <version> [--dry-run]
//
// Reads build/release/<version>/sov-{darwin-arm64,darwin-x64,linux-x64}.tar.gz,
// writes SHA256SUMS, runs `gh release create` against sov-releases.
//
// Required env:
//   SOV_RELEASES_PATH — for CHANGELOG.md (used as --notes-file)
//   GH_TOKEN          — required unless --dry-run
```

Combines `writeSums()` + `uploadRelease()` from current `release.ts`, plus a "verify all three tarballs present" check that fails fast with a helpful message if a build job dropped output.

Dry-run: stops after SHA256SUMS generation; prints the `gh release create` invocation that would have run.

**Idempotency:** before invoking `gh release create`, the script runs `gh release view <tag> --repo yevgetman/sov-releases`. If the release already exists (exit 0), the script prints `release already exists; skipping upload` and exits 0 successfully. This makes CI runs triggered by local-cut tag-pushes harmless (Actions UI stays green). It also makes `workflow_dispatch` re-runs against an already-published tag a no-op — the operator's recovery action when something goes wrong remains the explicit `gh release delete` + re-run, never an unintended overwrite.

`gh release create` uses `--notes-file ${SOV_RELEASES_PATH}/CHANGELOG.md` (lifted from current behavior). If the author forgot to update CHANGELOG.md, the release goes out with the existing top-of-file content; that's a fixable manual error, not a CI concern.

### 5.4 `scripts/release.ts` (refactored, ~90 lines)

After refactor:

```typescript
// scripts/release.ts — local-orchestrator entry point.
// Usage: bun run release v0.x.y [--dry-run]

import { spawnSync } from 'node:child_process';
import { TARGETS, die, note, run, capture, satisfies, repoRoot } from './release-shared';

function preflightLocal(version: string, dryRun: boolean): void {
  // Local-only checks: clean git, on master, package.json matches, gh auth,
  // Bun + Go versions, SOV_RELEASES_PATH set. Same logic as current
  // `preflight()`, lifted to keep release.ts a thin coordinator.
}

function tagAndPush(version: string): void {
  // Tag + push origin. Local-only; CI is triggered BY the tag, not the
  // other way around.
}

const args = process.argv.slice(2);
const version = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
if (!version) die('usage: bun run release v0.x.y [--dry-run]');

preflightLocal(version, dryRun);

for (const target of TARGETS) {
  run('bun', ['scripts/release-build-target.ts', target.name, version]);
}

run('bun', [
  'scripts/release-upload.ts',
  version,
  ...(dryRun ? ['--dry-run'] : []),
]);

if (!dryRun) tagAndPush(version);
note('done.');
```

Net behavioral change for local cuts: zero. The same flow that shipped v0.2.0 + v0.2.1 still works, just composed of three sub-scripts instead of one monolith.

## 6. Failure modes & recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Test/lint/typecheck fails in `preflight` | Workflow aborts at job 1. No artifacts. | Author fixes commit, force-pushes, retags. (Re-tagging requires deleting the old tag locally and on origin first — git limitation.) |
| `package.json` version doesn't match tag | `preflight` aborts with clear message | Author fixes `package.json`, recommits, retags. |
| Bun compile fails on a target | The relevant `build-*` job fails; `release` is skipped (depends-on) | Author fixes the bug, retags or re-dispatches. |
| Go cross-compile fails | Same as above | Same recovery. |
| Upload fails partway (token expired, GH API hiccup) | `release` job fails. `gh release create` is atomic on the GitHub side — either all assets attach or the release isn't created. | Re-run the `release` job from the Actions UI (artifacts from `build-*` are retained for 90 days; `gh release create` is re-runnable). If the release was half-created somehow, `gh release delete v0.x.y --repo yevgetman/sov-releases` first, then re-run. |
| `SOV_RELEASES_TOKEN` invalid / expired | `release` step fails with `gh: 401` | Author regenerates PAT in GitHub settings, updates repo secret, re-runs `release` job. |
| Dry-run via `workflow_dispatch` | Workflow runs through SHA256SUMS step, stops. Artifacts retained. | Inspect artifacts in the workflow run. No release was published. |
| Concurrent triggers (e.g., tag push AND manual dispatch for same version) | First trigger queues, second waits via `concurrency` group | No race; second run is a no-op against the now-existing release (the upload script can be extended to detect-and-skip-if-already-uploaded — see §8 follow-ups) |

**Idempotency note:** `release-upload.ts` performs `gh release view` before `gh release create` and exits 0 successfully if the release already exists. This handles the common case where a local `bun run release` cut already published, and the subsequent tag-push triggered CI — CI silently no-ops, Actions UI stays green. The upload script does NOT auto-delete or auto-clobber an existing release. If the operator wants to re-publish (e.g., to fix a partial-success scenario), they run `gh release delete v0.x.y --repo yevgetman/sov-releases` manually, then re-trigger the workflow.

## 7. Testing strategy

### 7.1 Unit tests

- `tests/scripts/release-shared.test.ts` — verify the utilities (`satisfies` corner cases, `sha256` deterministic hash, etc.)
- `tests/scripts/release-build-target.test.ts` — verify arg parsing, target lookup, error messages on bad input. Mock the actual compile commands (spawnSync stub). Verify it would invoke `bun build` and `go build` with the right args.
- `tests/scripts/release-upload.test.ts` — verify SHA256SUMS generation against synthetic tarballs, dry-run prints the `gh release create` command without executing, missing-tarball error message is clear.

Target: ~10–15 new test cases. Run inside the existing `bun run test` gate.

### 7.2 Integration / CI smoke

The first M2 release (e.g., `v0.5.x`) cut via the workflow IS the integration smoke. Pass criteria:
- Tag `vX.Y.Z` pushed → workflow fires
- All four jobs green
- GitHub release exists at `yevgetman/sov-releases/releases/tag/vX.Y.Z` with three tarballs + SHA256SUMS
- `curl -fsSL .../install.sh | bash` on a clean `~/.sov/` picks up the new version
- `~/.sov/bin/sov --version` prints `X.Y.Z`

If anything fails, the manual `bun run release v0.x.y` path remains operational as a fallback (its existing tests still pass — local cuts continue to work bit-for-bit).

### 7.3 Pre-merge validation

Before tagging the first M2 release:
- All extracted scripts run locally end-to-end via `bun run release v0.x.y --dry-run` → produces the same three tarballs + SHA256SUMS as before.
- Diff the dry-run artifacts against v0.2.1's known-good artifacts — sizes within ±10%, file lists identical, version file inside each tarball matches.
- `workflow_dispatch` with `dry-run: true` on a test tag (e.g., `v0.4.99` on a throwaway commit) — verifies the CI side end-to-end without publishing.

## 8. Follow-ups (out of scope for M2; documented for future sessions)

1. **Apple Developer signing + notarization** — adds `codesign` step on the `macos-14` runner and a `xcrun notarytool submit` step. Requires `APPLE_DEVELOPER_ID`, `APPLE_TEAM_ID`, `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_API_KEY_ID`, `APPLE_API_KEY_ISSUER`, `APPLE_API_KEY_P8_BASE64` secrets. Triggered by Apple Developer Program enrollment (~$99/yr).
2. **Idempotent uploads** — `release-upload.ts` could detect "release already exists" and `gh release upload --clobber` the assets instead of failing. Useful for partial-failure recovery without manual delete. Implement when a manual delete-and-retry actually happens.
3. **Homebrew tap** — `homebrew-sov` repo with a generated formula. CI step appends a new formula version on each release. Gated on a beta user actually asking for `brew install`.
4. **Auto-generated release notes** — `gh release create --generate-notes` instead of `--notes-file`. Adds commit-list to the GitHub release body. Useful when the author stops writing CHANGELOG.md by hand.
5. **Status badge** — add a "release: passing" badge to the private repo's `README.md` (the author sees it; not visible to beta users).

## 9. Effort & sequencing

Estimated single session, ~3–4 wall hours:

- ~30 min — refactor `scripts/release.ts` into the three extracted scripts; add unit tests
- ~45 min — write `.github/workflows/release.yml`; iterate locally with `act` if useful, otherwise commit + push + dispatch and iterate
- ~30 min — generate fine-grained PAT; configure repo secret; smoke `workflow_dispatch` with dry-run
- ~30 min — cut first M2 release (e.g., v0.5.x); validate end-to-end including beta-installer
- ~30 min — write state snapshot; close backlog `#48`; update `docs/05-conventions/cutting-releases.md`
- ~30 min — ADR in DECISIONS.md; testing-log entry; canonical build-plan note in sister docs repo
- ~15 min buffer

The first cut may need 1–2 workflow iterations to debug (typos in YAML, secret-naming mismatches, etc.). Each iteration is ~5 min wall time + ~5–10 billable minutes. Acceptable.

## 10. Open questions

None blocking. Two minor calls that the author can override during plan execution:

1. **`actions/checkout@v4` vs `@main`** — pinning to `@v4` (current major). Switch to a SHA pin if a security review demands it; not warranted for an internal release pipeline.
2. **`bun install --frozen-lockfile` vs `--no-lockfile`** — frozen-lockfile ensures reproducible builds, matches the testing convention in this repo. Locked.

---

**Next step:** invoke `superpowers:writing-plans` to produce the executable implementation plan at `plans/2026-05-24-phase-21-m2-release-automation.md`. Plan execution follows in the same session per the autonomous-proceed directive.
