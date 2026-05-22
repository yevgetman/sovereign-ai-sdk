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

## Procedure

Pre-flight (the script self-checks all of these — fail fast if missing):

- Clean git tree on `master`.
- `bun run lint && bun run typecheck` green (full test suite is sufficient but not required — the unit suite ran for the actual changes earlier in the session).
- `SOV_RELEASES_PATH=/Users/julie/code/sov-releases` exported (set up via `git clone git@github.com:yevgetman/sov-releases.git /Users/julie/code/sov-releases` on a fresh machine).
- `gh auth` working against the user's account.
- `Bun ≥ 1.2` + `Go ≥ 1.24` on `PATH`.

Steps:

1. Bump the patch level in `package.json`: `X.Y.Z` → `X.Y.(Z+1)`.
2. Commit `chore(release): bump version X.Y.Z -> X.Y.(Z+1)` with a body listing every behavioral change since the last release tag.
3. Push to `origin/master`.
4. `SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release vX.Y.(Z+1)`.

The script compiles for `darwin-arm64`, `darwin-x64`, `linux-x64`, tars each, computes SHA256SUMS, pushes the `vX.Y.(Z+1)` tag, and calls `gh release create` against `yevgetman/sov-releases`. Wall time ~3 min on a recent M-series Mac.

5. (Optional) Smoke: `sov upgrade` on the dev host's `~/.sov/bin/sov` to pick up the new release. The installer should report the new version on `sov --version`.

## History note (2026-05-22)

The rule was added after the user filed a "Fix A is still there in `0.2.1`" bug. Fix A landed in commit `571d202` (afternoon) but the v0.2.1 binary tarball had been cut at the morning's `7b02542`, before the fix. The user had to explicitly ask for a v0.2.2 release. Going forward, every session that touches runtime code cuts its own release as part of the wrap-up.

## See also

- [`sov-upgrade.md`](sov-upgrade.md) — the source-mode equivalent (keep `~/.bun/bin/sov` current). Applies to developer hosts; the binary-release procedure here applies to the user-facing distribution.
- `scripts/release.ts` — the release orchestrator.
- `docs/specs/2026-05-21-binary-distribution-design.md` — the Phase 21 design that introduced the binary-install path.
- `docs/state/2026-05-22-phase-21-m1.md` — the Phase 21 M1 close-out detailing the public-repo layout.
