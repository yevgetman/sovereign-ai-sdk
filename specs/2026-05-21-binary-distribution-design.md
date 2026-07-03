# Phase 21 — Binary distribution & portability design

**Date:** 2026-05-21
**Status:** Approved (this design). Seven ADRs locked (P21-01..07). Awaiting plan + execution.
**Predecessor:** Current install story — `bun install -g git+ssh://…` against the private `sovereign-ai-sdk` repo. Requires Bun, requires SSH access to the private repo, exposes full source. See [Phase 0.6 repo layout](https://example.local/runtime/harness-build-plan.md#06-repo-layout) and [`docs/05-conventions/sov-upgrade.md`](docs/05-conventions/sov-upgrade.md).
**Driver:** Need to share the harness with internal trusted colleagues plus beta users in the author's social circle. Beta users must NOT see source. Sharing is allowed to be clunky-but-functional (one-line install command).

## 1. Purpose

Produce installable compiled binaries of `sov` for the three Unix platforms the author and beta users actually run (darwin-arm64, darwin-x64, linux-x64), distributed via GitHub Releases on a separate public repo so source stays private. Beta users run a single `curl | bash` command and get a working `sov` CLI with TUI, the default bundle, and `sov upgrade` that knows it's in binary-mode.

Out of scope for Phase 21: open-sourcing, Windows support, code-signing/notarization, homebrew tap, automatic update notifications, telemetry. Each of these is a Phase 21 follow-up or a separate phase entirely.

## 2. Scope

**In scope (M1 — manual release pipeline):**
- New `scripts/release.ts` in this repo that produces per-platform tarballs and uploads them to GitHub Releases on the separate `sov-releases` public repo via `gh release create`.
- Switch `src/bundle/defaultBundle.ts` (or whichever module resolves the default bundle path) to a runtime asset-discovery scheme that works both in source mode and in binary mode. See ADR P21-02.
- One-time setup of the `sov-releases` public repo:
  - `README.md` — install instructions for beta users
  - `LICENSE.txt` — beta evaluation license (see ADR P21-06)
  - `install.sh` — the public installer script
  - First release: `v0.2.0` with three tarballs + `SHA256SUMS`
- `src/cli/upgrade.ts` (or whichever file owns `sov upgrade`) — add a binary-mode branch that re-runs the public installer. Source-mode path unchanged. See ADR P21-05.
- One macOS install smoke test + one Linux install smoke test (manual; documented in `docs/06-testing/testing-log.md`).
- New state snapshot `docs/07-history/state/YYYY-MM-DD-phase-21-m1.md`.
- 1–2 new ADRs in `DECISIONS.md` covering the load-bearing choices (asset-discovery, upgrade-mode detection).
- Update `README.md` (this repo) to mention "binary install" as the recommended path for non-developers.
- Add Phase 21 entry to the canonical build plan at `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`, slotted between Phase 20 and "Beyond Phase 20".

**Out of scope (M1):**
- GitHub Actions release automation. Manual local `bun run release v0.2.0` is the only release surface in M1. Automation lives in **M2 (Phase 21.B)**.
- Windows support, linux-arm64 support, signed/notarized macOS binaries, homebrew tap. All Phase 21 follow-ups or later.
- Auto-update notifications inside the running CLI. Beta users learn about updates the same way today's source-install users learn — out-of-band.
- Telemetry / install-count tracking.
- Any change to the Go TUI's build target other than adding the three cross-compile pairs. The TUI code itself doesn't change.
- Any change to the runtime's tool surface, providers, or session semantics.

## 3. Design decisions (ADRs)

### ADR P21-01 — Install layout under `~/.sov/`

The installer places everything under `~/.sov/`:

```
~/.sov/
├── bin/
│   ├── sov              # the Bun-compiled CLI
│   └── sov-tui          # the Go TUI binary
├── bundle-default/      # the harness's default bundle (copied verbatim from the tarball)
└── version              # the installed tag, e.g. "v0.2.0", written by install.sh
```

`~/.sov/bin/` is appended to `PATH` via the user's shell rc file (`~/.zshrc`, `~/.bashrc`). The installer detects the active shell from `$SHELL` and appends one line to the appropriate file; if it can't detect, it prints the instruction and exits cleanly. The PATH-append is idempotent (the line is grep-guarded so re-running the installer doesn't duplicate it).

**Why not `/usr/local/bin/`?** Avoids `sudo`. Beta users on macOS without admin rights still work. Symmetric with how `bun`, `deno`, `rustup` install today.

### ADR P21-02 — Bun `--compile` with side-car bundle directory

`sov` is compiled per-platform:

```bash
bun build --compile \
  --target=bun-darwin-arm64 \
  --outfile=sov \
  src/main.ts
```

The Bun-compiled binary embeds all TypeScript source + the Bun runtime as a single executable. Casual users cannot read the source (it's compiled to Bun's internal bytecode embedded in a native shell). Determined attackers can disassemble — that's a problem we punt to a later phase if it ever matters.

`bundle-default/` is NOT embedded into the binary. It ships as a sibling directory in the tarball, and the runtime discovers it at startup:

1. Compute `installRoot = path.dirname(path.dirname(process.execPath))`. For `~/.sov/bin/sov`, this resolves to `~/.sov/`.
2. If `${installRoot}/bundle-default/` exists, use that as the default bundle path.
3. Otherwise (source mode — running `bun src/main.ts` from the repo), fall back to the existing repo-relative discovery (`import.meta.dir` walk up to the repo root).

The fallback preserves today's developer workflow exactly. Binary mode is the new branch.

**Why a side-car directory instead of embedding into the binary?** The default bundle is ~hundreds of files; using `import … with { type: 'file' }` for each one would balloon `defaultBundle.ts`. Side-car is the same pattern used by `node` (where node_modules sit next to the entry point) and most CLI distributions (where assets sit beside the binary).

### ADR P21-03 — Public release repo: `sov-releases`

Create a new GitHub repo: **`sov-releases`** (public).

Contents:
- `README.md` — product description, install command, link to author for support, beta-tester onboarding
- `LICENSE.txt` — beta evaluation license (see P21-06)
- `install.sh` — the public installer, raw-fetchable at `https://raw.githubusercontent.com/<owner>/sov-releases/main/install.sh`
- `CHANGELOG.md` — high-level per-release notes (no source diffs, no commit SHAs from the private repo)
- GitHub Releases — tagged `v0.2.0`, `v0.2.1`, etc. Each release has the three tarballs + `SHA256SUMS`.

No code from this repo lives in `sov-releases`. The private repo's git history, source, design docs, ADRs — none of it is mirrored. Only built artifacts.

**Why a separate repo?** Cleanest separation; trivially permissionable; if the private repo is ever opened or renamed, the public install URL doesn't change.

### ADR P21-04 — `install.sh` at `raw.githubusercontent.com`

Beta users install with:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/sov-releases/main/install.sh | bash
```

`install.sh` is ~120 lines of POSIX shell. Behavior:

1. **Detect platform.** `uname -s` for OS, `uname -m` for arch. Map to one of `darwin-arm64` / `darwin-x64` / `linux-x64`. Unsupported pair → print friendly error + supported list, exit 1.
2. **Fetch latest release.** `curl https://api.github.com/repos/<owner>/sov-releases/releases/latest` → parse `tag_name` + tarball asset URL.
3. **Download tarball.** `curl -fLO <url>` to a temp dir.
4. **Verify checksum.** Fetch `SHA256SUMS` from the same release; verify the tarball line. Abort if mismatch.
5. **Extract.** `tar -xzf` into `~/.sov/` (creating it). Atomic: extract to `~/.sov.tmp/`, then `mv ~/.sov.tmp ~/.sov` (with a backup of the previous `~/.sov/` if present).
6. **Make executable.** `chmod +x ~/.sov/bin/sov ~/.sov/bin/sov-tui`.
7. **Write version.** `echo "<tag>" > ~/.sov/version`.
8. **PATH append.** Detect shell from `$SHELL` basename; if `zsh`, append a guarded line to `~/.zshrc`; if `bash`, append to `~/.bashrc`; else print the instruction and proceed.
9. **macOS quarantine note.** On macOS, print: "First run may show 'macOS cannot verify the developer.' Run `xattr -d com.apple.quarantine ~/.sov/bin/sov ~/.sov/bin/sov-tui` to dismiss permanently." Phase 21 follow-up addresses signing.
10. **Done message.** Print version, install path, "Run `sov --version` to verify."

The installer is idempotent — re-running upgrades to the latest release.

### ADR P21-05 — `sov upgrade` detects binary mode

Today's `sov upgrade` (`src/cli/upgrade.ts`, with tests at `tests/cli/upgrade.test.ts`) runs `bun install -g git+ssh://…`. That only works for source installs.

Extend `sov upgrade`:

1. Resolve `process.execPath`. Detect binary mode by checking whether the path starts with `${homedir}/.sov/bin/` OR whether there's no `package.json` sibling tree above the executable (source installs always have one).
2. **Binary mode:** shell out to `bash -c "curl -fsSL https://raw.githubusercontent.com/<owner>/sov-releases/main/install.sh | bash"` and exit on its status.
3. **Source mode:** unchanged — existing `bun install -g` flow.

One conditional branch. No new dependencies. No special "binary updater" code path beyond re-invoking the public installer.

### ADR P21-06 — Beta evaluation license (not open source)

`LICENSE.txt` shipped inside every tarball + at the root of `sov-releases`:

> **Sovereign AI Harness — Beta Evaluation License**
>
> Copyright © 2026 `<author-legal-name>`. All rights reserved.
>
> This software is provided to you for personal evaluation and testing purposes only. You may install and run it on machines you control. You may not:
>
> - Redistribute, resell, sublicense, or share the software or any portion of it
> - Reverse-engineer, decompile, or attempt to extract source code
> - Use the software in production systems or commercial offerings
> - Use the software to train machine-learning models
>
> The software is provided "as is," without warranty of any kind. The author is not liable for any damages arising from its use.
>
> This license terminates automatically on any breach. On termination you must delete all copies.
>
> Contact yevgetman@gmail.com for any other usage.

The source repo's `package.json` keeps `"license": "UNLICENSED"` (npm convention for "not published under an open license"). The beta-license is a separate document shipped with the binary distribution; the source code itself is not licensed for any third-party use until/unless the author chooses to open-source.

**Future option:** Phase 21 follow-up can replace this with MIT/Apache-2.0 if/when the author decides to open the source. That's a no-cost forward path; nothing in this design blocks it.

### ADR P21-07 — Platform matrix: darwin-arm64, darwin-x64, linux-x64

**Day-one matrix:**

| Target | Bun `--target` | Go `GOOS`/`GOARCH` | Rationale |
|---|---|---|---|
| `darwin-arm64` | `bun-darwin-arm64` | `darwin`/`arm64` | Author + most beta users; primary target |
| `darwin-x64` | `bun-darwin-x64` | `darwin`/`amd64` | Intel Mac users in the social circle |
| `linux-x64` | `bun-linux-x64` | `linux`/`amd64` | Some beta users; covers Ubuntu / Debian / common cloud Linux |

**Explicitly excluded from M1:**

- **Windows.** The harness uses Unix-isms in shell handling and the TUI assumes a real terminal. Plus: no beta user has asked. Adding Windows is a separate phase if needed; expect ~1 session of porting work.
- **linux-arm64.** Niche (Raspberry Pi, ARM cloud instances). Add when an actual beta user needs it.
- **Alpine / musl linux.** Bun publishes a musl target; defer until requested.

## 4. Build pipeline (M1, manual)

New file: **`scripts/release.ts`** — invoked locally by the author as `bun run release v0.2.0`.

```text
1. Parse version arg.
2. Verify clean git status. Verify on master. Verify tests pass: bun run lint && bun run typecheck && bun run test.
3. Create build dir: build/release/<version>/
4. For each target in [darwin-arm64, darwin-x64, linux-x64]:
   a. Compile TS:
      bun build --compile --target=bun-<target> --outfile=build/release/<version>/<target>/bin/sov src/main.ts
   b. Cross-compile Go:
      GOOS=<os> GOARCH=<arch> go build -o build/release/<version>/<target>/bin/sov-tui ./cmd/sov-tui
      (run inside packages/tui/)
   c. Copy bundle-default/ → build/release/<version>/<target>/bundle-default/
   d. Copy ../sov-releases/LICENSE.txt → build/release/<version>/<target>/LICENSE.txt
   e. Copy README.binary.md → build/release/<version>/<target>/README.md
   f. Tar: tar -czf build/release/<version>/sov-<target>.tar.gz -C build/release/<version>/<target> .
5. Generate build/release/<version>/SHA256SUMS by hashing the three tarballs.
6. Tag the private repo: git tag <version> && git push origin <version>
7. Push to sov-releases:
   gh release create <version> --repo <owner>/sov-releases \
     --notes-file CHANGELOG.md \
     build/release/<version>/sov-darwin-arm64.tar.gz \
     build/release/<version>/sov-darwin-x64.tar.gz \
     build/release/<version>/sov-linux-x64.tar.gz \
     build/release/<version>/SHA256SUMS
8. Print: "Release <version> live at https://github.com/<owner>/sov-releases/releases/tag/<version>"
```

Total wall time: ~2–3 minutes per platform (Bun compile dominates), so ~10 minutes end-to-end. Acceptable for the manual flow.

**Pre-flight checks** the script enforces:
- Clean git tree (no uncommitted changes)
- On `master` branch
- All three pre-commit gates pass (`lint`, `typecheck`, `test`)
- `gh` CLI authenticated for `sov-releases` repo
- Bun version ≥1.2.0 (the engines requirement)
- Go version ≥1.24 (current TUI requirement)

Any failure aborts before any artifact is uploaded.

## 5. Runtime asset discovery — implementation sketch

The single load-bearing source-code change in M1 is teaching `src/bundle/defaultBundle.ts` where to find `bundle-default/` when running as a Bun-compiled binary.

Today the file has two resolvers — `userOverridePath()` (returns `<harness-home>/default-bundle/`) and `shippedBundlePath()` (walks up three levels from `import.meta.url` to the repo root and returns `<repo>/bundle-default/`). The two-step fallthrough at `getDefaultBundlePath()` checks the override first, then the shipped path.

In Bun-compiled mode, `import.meta.url` resolves to a virtual path inside the compiled binary (Bun's embedded filesystem), not to the on-disk source file — so `shippedBundlePath()` returns a path that doesn't exist on the user's machine. The runtime falls all the way through to the null branch and runs in bundleless mode. Not what we want.

The fix: extend `shippedBundlePath()` to try a binary-install location FIRST, using `process.execPath` (which always resolves to the actual on-disk executable, including in `bun build --compile` binaries). Fall back to the existing `import.meta.url` walk when the binary-install check fails — which happens for every source-mode invocation (`bun src/main.ts`, `bun install -g`, `bun link`), preserving today's behavior exactly.

```typescript
export function shippedBundlePath(): string | null {
  // Binary mode: process.execPath points to the standalone Bun-compiled
  // executable on disk (e.g., ~/.sov/bin/sov). Look for a bundle-default/
  // dir at <execDir>/../bundle-default. The check is content-based
  // (existsSync of index.yaml), not path-based, so it works for any
  // install layout, not just ~/.sov/.
  try {
    const execDir = dirname(realpathSync(process.execPath));
    const candidate = join(dirname(execDir), 'bundle-default');
    if (existsSync(join(candidate, 'index.yaml'))) return candidate;
  } catch {
    /* fall through to source-mode resolver */
  }

  // Source mode: walk up from this file's URL.
  // For `bun src/main.ts` or `bun install -g` installs, process.execPath
  // is the Bun executable itself (e.g., /Users/x/.bun/bin/bun) and the
  // binary-mode check above fails by design — there's no bundle-default
  // sibling next to bun. This branch handles those installs unchanged.
  try {
    const realMain = realpathSync(fileURLToPath(import.meta.url));
    return join(dirname(dirname(dirname(realMain))), 'bundle-default');
  } catch {
    return null;
  }
}
```

Net behavioral change: zero for any current install mode. New behavior: Bun-compiled binaries with a sibling `bundle-default/` directory resolve correctly.

**Tests to add (`tests/bundle/defaultBundle.test.ts`):**
- New case: `process.execPath` points to a synthetic dir with a sibling `bundle-default/index.yaml` → returns that path.
- New case: `process.execPath` points to a dir with no sibling bundle → falls through to `import.meta.url` walk.
- Existing source-mode cases unchanged.

This is the only runtime-side modification. Everything else is build/release tooling and a new public repo.

## 6. Risks & open questions

1. **`bun build --compile` with `bun:sqlite`.** The runtime uses `bun:sqlite` for session persistence. `bun:sqlite` is a Bun built-in, so it's part of the embedded runtime in `--compile` mode — expected to work. **Validation:** 10-minute spike before M1 starts; build a hello-world binary that opens a sqlite DB and confirm it runs on a clean machine. If it fails: extract the sqlite DB path to a runtime config + accept that the embedded Bun handles sqlite differently, OR pre-create the DB at install time. No known showstopper.

2. **macOS Gatekeeper / quarantine.** Unsigned binaries downloaded via `curl` get a `com.apple.quarantine` extended attribute. First run prompts the user. The installer prints the `xattr -d` workaround. **Beta-acceptable**. Phase 21 follow-up addresses by registering for an Apple Developer account ($99/yr) and notarizing via `codesign` + `notarytool`.

3. **Bun `--compile` target naming.** Bun uses `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64`. Verify exact flag spelling in current Bun release notes during M1 implementation.

4. **Bundle-default size.** `bundle-default/` includes agents, skills, business docs, instinct examples — likely tens of MB. Total tarball size estimate: ~80–150 MB per platform. Acceptable for GitHub Releases (2 GB per asset limit). Beta users on slow connections might wait 10–30s — fine for a one-time install.

5. **`gh release create` rate limits.** Public repo, free tier — ample. No concern at the author's release cadence.

6. **Install path collision.** If a beta user already has `~/.sov/` from a different tool or prior experimentation, the installer's atomic move-replace pattern preserves their old install as `~/.sov.bak.<timestamp>/`. Documented in the install message.

7. **`sov upgrade` detection edge cases.** What if a developer runs the binary install on the same machine they have source-mode? `process.execPath` resolves the actual invoked binary — so `~/.sov/bin/sov upgrade` runs binary-mode upgrade; `bun src/main.ts upgrade` runs source-mode upgrade. Distinct paths, distinct branches. No ambiguity.

## 7. Testing & smoke plan

**Pre-release validation (per release, before tagging):**
- `bun run release v0.2.0 --dry-run` — same flow but skips the `gh release create` step. Verify all artifacts are produced.
- Inspect each tarball: `tar -tzf sov-darwin-arm64.tar.gz` shows the expected layout.
- Verify each binary's basic functionality: `./bin/sov --version` prints the expected version SHA on the host platform.

**Per-release smoke (manual, ~10 min):**
1. **macOS (host):** wipe `~/.sov/`, run the `curl | bash` installer, run `sov --version`, run `sov` (interactive TUI), exit cleanly, run `sov upgrade` (should detect "already latest").
2. **Linux (via a clean VM or Docker container):** same flow on Ubuntu 22.04 minimal image.
3. **darwin-x64:** if no Intel Mac available, defer to first beta tester's report. M1 ships if M1.1+M1.2 pass.

**Append to `docs/06-testing/testing-log.md`** for each release attempt — pass/fail with notes.

## 8. Rollback

Each release is independent — `gh release create` doesn't touch prior releases. If `v0.2.1` ships broken:
- Mark `v0.2.1` as draft (or delete it): `gh release delete v0.2.1 --repo <owner>/sov-releases`
- Beta users who already installed v0.2.1 keep working until they `sov upgrade` next; their next upgrade picks up `v0.2.0` (the new latest).
- A `v0.2.2` fix-release supersedes `v0.2.1` without ceremony.

Source-mode users are unaffected by any release engineering issue — they install from git directly.

## 9. Phase plan slot

Add to `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` between **Phase 20 — Optional Slack adapter** and **Beyond Phase 20 — things worth eventually adding**:

```markdown
## Phase 21 — Binary distribution & portability (1 session)

**Goal:** Ship `sov` as installable compiled binaries for darwin-arm64, darwin-x64, and linux-x64 via a separate public `sov-releases` repo + a one-line `curl | bash` installer. Source stays private.

**Driver:** Need to share the harness with internal trusted colleagues plus beta users without exposing source code.

**Orthogonal to Phase 13.5 (scheduled-mission sub-agents) and any later phase.** Can run before or after; introduces no runtime constraints on other phases.

**M1 — Manual release pipeline (this phase):**
- `scripts/release.ts` — local `bun run release v0.x.y` that compiles + uploads
- Runtime asset discovery in `src/bundle/defaultBundle.ts` — binary-mode + source-mode branches
- Public `sov-releases` repo with `install.sh` + `LICENSE.txt` + `README.md`
- `sov upgrade` detects binary mode + re-runs installer
- macOS + Linux smoke tests per release

**M2 — Release automation (follow-up, scheduled separately):**
- GitHub Actions workflow in `sov-releases` (pulls private repo as a deploy-key clone, runs the release script, uploads artifacts)
- Optional macOS code-signing + notarization (requires Apple Developer account)
- Optional homebrew tap

**Out of scope for Phase 21:** Windows, linux-arm64, code-signing, homebrew, auto-update notifications, telemetry, open-sourcing.

**Check:** Wipe `~/.sov/`. Run `curl -fsSL https://raw.githubusercontent.com/<owner>/sov-releases/main/install.sh | bash`. Run `sov --version` → prints v0.2.0. Run `sov` → TUI starts, default bundle loaded, basic turn works. Run `sov upgrade` → no-op (already latest).

**Rhyme with Claude Code:** Claude Code ships as `@anthropic-ai/claude-code` on npm — a published package. Sovereign-AI's beta phase uses GitHub Releases instead (npm publish would expose source); the architectural pattern is identical (binary + assets + auto-install).

**Invariants reinforced:** none new — Phase 21 is release engineering, not runtime architecture.

**Spec:** `specs/2026-05-21-binary-distribution-design.md` in the harness repo.
```

## 10. Open questions for the author

1. **Repo owner.** The public repo will be `github.com/<owner>/sov-releases`. Confirm `<owner>` — assumed `yevgetman` per the private repo. If a separate GitHub org makes sense for the product brand, decide before M1.
2. **Repo name spelling.** Confirmed `sov-releases` (plural) per the brainstorming step. Locked.
3. **First version tag.** Suggesting `v0.2.0` (matches the binary distribution milestone vs. the current `0.1.0` in `package.json`). Confirm or override.
4. **Beta evaluation license text.** The wording in P21-06 is a starting point. The author should read it once before the first release and revise. Final wording lives in `sov-releases/LICENSE.txt`. The `<author-legal-name>` placeholder needs filling.

## 11. Effort & sequencing

**M1 — single session, 4–6 wall hours:**
- ~30 min: bundle-default asset-discovery patch + tests
- ~30 min: `sov upgrade` binary-mode branch + tests
- ~60 min: `scripts/release.ts` (compile/cross-compile/tar/upload)
- ~60 min: stand up `sov-releases` repo (README, LICENSE, install.sh, first manual upload)
- ~30 min: macOS smoke + Linux smoke
- ~30 min: docs sweep — README, state snapshot, ADRs, testing log
- ~30 min: canonical build plan edit + commit

**M2 (separate session, after first beta user feedback):** ~3–4 wall hours for GitHub Actions automation. Triggered when manual releases start feeling like friction.

---

**Next step after this spec is approved:** invoke `superpowers:writing-plans` to produce the executable implementation plan at `plans/2026-05-21-phase-21-m1-binary-distribution.md`. Plan execution happens when the author schedules it — likely after a small validation spike on `bun build --compile` with `bun:sqlite`.
