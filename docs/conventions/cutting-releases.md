# Cutting binary releases

The user runs the public binary install at `~/.sov/bin/sov` (curl-piped from `github.com/yevgetman/sov-releases`). The source-mode install at `~/.bun/bin/sov` exists too but is for developers — it's NOT what the user sees on a day-to-day basis.

## The rule

**Any session that changes runtime code — `src/`, `bundle-default/`, or `packages/tui/` — must cut the next patch release in the same session.** Don't wait for the user to ask. Without the release, the user's `~/.sov/bin/sov` keeps running the stale binary and the fix isn't real to them.

This applies even after `bun link` + `sov upgrade` on the source-mode install — that path updates `~/.bun/bin/sov`, not `~/.sov/bin/sov`.

## When to skip

Skip the release ONLY when the session was 100% docs / tests / conventions / build-config:

- `docs/**` — no binary impact.
- `tests/**` — test code doesn't ship in the binary.
- `*.md` at repo root — same.
- `.github/**`, `.gitignore`, lint config — no binary impact.
- `scripts/` — release tooling itself; only ship if its output changes binary behavior.

When in doubt, cut it. ~3 min wall time and ~30 MB per platform is cheap insurance.

## Procedure (CI-driven, recommended)

After Phase 21 M2 (2026-05-25), the canonical release flow is tag-driven CI:

1. Bump the version in `package.json`: `X.Y.Z` → `X.Y.(Z+1)`.
2. Commit `chore(release): bump version X.Y.Z -> X.Y.(Z+1)` with a body listing every behavioral change since the last release tag.
3. Push to `origin/master`.
4. Update `$SOV_RELEASES_PATH/CHANGELOG.md` with the new version entry. Commit + push that to the public repo.
5. `git tag vX.Y.(Z+1) && git push origin vX.Y.(Z+1)`.

The tag-push triggers `.github/workflows/release.yml` in the private repo, which:

- preflight (ubuntu): re-runs `bun run lint && bun run typecheck && bun run test`, asserts `package.json` version matches the tag
- build-darwin (macos-14): cross-compiles `darwin-arm64` + `darwin-x64` tarballs in parallel with the linux job; native-smokes the arm64 binary's `--version`
- build-linux (ubuntu): builds the `linux-x64` tarball; native-smokes its `--version`
- release (ubuntu): downloads artifacts, computes `SHA256SUMS`, runs `gh release create` against `yevgetman/sov-releases` using the `SOV_RELEASES_TOKEN` fine-grained PAT

Wall time ~4-12 minutes (v0.6.0 first cut was ~4 min). Watch via `gh run watch -R yevgetman/sovereign-ai-harness`.

If the upload step finds the release already exists, it exits 0 with a notice (idempotency). To re-publish a tag with new artifacts, `gh release delete vX.Y.Z --repo yevgetman/sov-releases` first, then re-dispatch the workflow.

## Procedure (local fallback, when CI is broken)

`scripts/release.ts` still works end-to-end. Pre-flight requirements (the script self-checks all of these):

- Clean git tree on `master`.
- `bun run lint && bun run typecheck && bun run test` green.
- `SOV_RELEASES_PATH=/Users/julie/code/sov-releases` exported (clone via `git clone git@github.com:yevgetman/sov-releases.git /Users/julie/code/sov-releases` on a fresh machine).
- `gh auth` working against the user's account.
- `Bun ≥ 1.2` + `Go ≥ 1.24` on `PATH`.
- `package.json` version matches the version arg (e.g., arg `v0.6.0` requires package.json `0.6.0`).

Steps:

1. Bump `package.json`, commit, push, update CHANGELOG (as steps 1-4 above).
2. `SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release vX.Y.(Z+1)`.

The script compiles per-target, tars, computes SHA256SUMS, runs `gh release create`, then tags + pushes the private repo. The subsequent tag-push will fire CI; CI sees the already-published release and silently exits successful.

(Optional) Smoke: `sov upgrade` on the dev host's `~/.sov/bin/sov` to pick up the new release.

## History note (2026-05-22)

The rule was added after the user filed a "Fix A is still there in `0.2.1`" bug. Fix A landed in commit `571d202` (afternoon) but the v0.2.1 binary tarball had been cut at the morning's `7b02542`, before the fix. The user had to explicitly ask for a v0.2.2 release. Going forward, every session that touches runtime code cuts its own release as part of the wrap-up.

## See also

- [`sov-upgrade.md`](sov-upgrade.md) — the source-mode equivalent (keep `~/.bun/bin/sov` current). Applies to developer hosts; the binary-release procedure here applies to the user-facing distribution.
- `scripts/release.ts` — the release orchestrator.
- `docs/specs/2026-05-21-binary-distribution-design.md` — the Phase 21 design that introduced the binary-install path.
- `docs/state/2026-05-22-phase-21-m1.md` — the Phase 21 M1 close-out detailing the public-repo layout.
