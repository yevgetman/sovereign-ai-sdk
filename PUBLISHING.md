# PUBLISHING — the release runbook for the open packages

> **This runbook is documentation for a human — the CEO runs these steps
> personally.** Publishing to the public npm registry is **irreversible**
> (a published version can be deprecated but never truly recalled, and
> unpublish windows are narrow). No agent or automation executes this
> sequence; the build pipeline hard-stops at `npm publish --dry-run`
> (spec GC-9 / §9.6).

Packages covered: `@yevgetman/sov-sdk` (`packages/sdk`) and
`@yevgetman/sov-protocol` (`packages/protocol`). The repo root
(`@yevgetman/sov`) is the private wrapper — **never published**.

---

## 0. Preconditions (all must be green before anything else)

- [ ] **CI green** on the branch being released (and on `master` if releasing
      from it) — both jobs: `gate` (lint + boundary + typecheck) and
      `packages` (build + package tests + canary + dry-runs) in
      `.github/workflows/ci.yml`.
- [ ] **Local canary green:** `bun run canary` — packs each package, installs
      the tarball into a scratch project, runs the consumer under **both**
      `node` and `bun`, and runs the shipped-artifact purity check (no
      `bun:sqlite`, no wrapper imports) against the installed tree.
- [ ] **Both dry-runs green:**
      ```sh
      cd packages/protocol && npm publish --dry-run
      cd packages/sdk      && npm publish --dry-run
      ```

## 1. Versioning

- Set each package's `version` in its `package.json`. **First release:
  `0.1.0` for both** (already set). Each package has its own independent
  semver line (see `STABILITY.md`); they do not need to move in lockstep.
- **`workspace:*` — what matters and what doesn't:**
  - The `workspace:*` dependencies in the **root** `package.json`
    (`@yevgetman/sov-sdk`, `@yevgetman/sov-protocol`) belong to the private
    wrapper `@yevgetman/sov`, which is never published — **no rewrite
    concern there.**
  - **Today neither open package depends on the other** (verified:
    `packages/protocol` has zero runtime dependencies; `packages/sdk`'s
    dependencies are six third-party packages) — so no `workspace:*`
    specifier appears in either published manifest.
  - **If a published package ever depends on a sibling:** plain
    `npm publish` does **not** rewrite `workspace:*` and would ship a broken
    manifest. Use `bun publish` (which rewrites the workspace protocol to
    concrete versions at pack time) or a release tool that pre-rewrites
    (e.g. changesets). Re-check this the day such a dependency is added.
- **Pre-publish nicety (not a blocker):** in Bun-compiled-binary mode
  (`bun build --compile`) the SDK's `packages/sdk/src/version.ts` cannot
  find a `package.json` inside the `/$bunfs/` virtual filesystem and falls
  back to `0.0.0` (ledgered in
  `docs/08-roadmap/sdk-extraction-deferred-work.md`; the user-facing
  `sov --version` is unaffected — it reads the wrapper's own version
  source). If compiled artifacts should report a real SDK version, inject a
  compile-time constant via `--define` in the release build
  (`scripts/release-build-target.ts`) and have `version.ts` prefer it.

## 2. Build, pack, inspect

```sh
bun run build                      # tsc emit for both packages
cd packages/protocol && npm pack   # emits yevgetman-sov-protocol-<v>.tgz
cd packages/sdk      && npm pack   # emits yevgetman-sov-sdk-<v>.tgz
```

Inspect each tarball before publishing:

```sh
tar -tzf <tarball>.tgz | sort | less
```

Expected contents (and nothing else) — the same allow-list the tarball tests
(`packages/*/tests/tarball.test.ts`) enforce:

- `package/dist/**` — compiled `.js` + `.d.ts` only
- `package/src/**` — the TypeScript source (ships by design: the `bun`
  exports condition resolves it; in-src `README.md` docs ride along)
- `package/LICENSE` (MIT)
- `package/README.md`
- `package/package.json`

**Red flags:** anything under `tests/`, any `tsconfig*`, any path that isn't
`dist`/`src`/the three root files. Note `prepack` runs `rm -rf dist && bun
run build`, so pack output is always a fresh build.

**Before publishing:** both package READMEs link `[STABILITY.md](../../STABILITY.md)`
— a relative path that is dead on npmjs.com (STABILITY.md is not in the tarball).
Convert those links to absolute GitHub URLs (they 404 until the repo flips public
— acceptable; the READMEs' inline "Public surface & versioning" summaries carry
the essentials meanwhile) or add STABILITY.md to each package's `files`.

## 3. Publish

**Auth prerequisites (one-time):**

- An npmjs.com account that owns (or has publish rights to) the
  **`@yevgetman` scope** — the scope must exist on the registry (user scope
  of the `yevgetman` account, or an org named `yevgetman`).
- **2FA enabled** on the account (npm prompts for an OTP at publish time —
  keep the authenticator at hand).
- Logged in locally: `npm whoami` (else `npm login`).

**Publish — protocol first, then sdk** (no dependency either way; the order
is alphabetical convention only). Scoped packages default to *restricted*,
so `--access public` is required:

```sh
cd packages/protocol && npm publish --access public
cd packages/sdk      && npm publish --access public
```

Post-publish smoke: `npm view @yevgetman/sov-protocol version` and
`npm view @yevgetman/sov-sdk version` report the released versions; a
scratch `npm install` of each from the registry resolves.

## 4. Tag and push

```sh
git tag protocol-v0.1.0
git tag sdk-v0.1.0
git push origin protocol-v0.1.0 sdk-v0.1.0
```

(Adjust versions per release; the two tags move independently, matching the
independent semver lines.)

## 5. The repo-public flip — a SEPARATE decision

Publishing the two packages does **not** require making this repository
public — the tarballs are self-contained. Flipping the repo public is its own
irreversible decision with its own checklist; do not fold it into a package
release.

- [ ] **Full-history secrets audit.** A public flip exposes **every commit
      ever made**, not just HEAD. This repo has precedent for secret material
      reaching captured artifacts: the audit-era fix `4d6c815`
      ("redact secrets reaching the corpus + escaped auth headers") and the
      Twilio secret-redaction fix `1e29eb3` both landed *after* the paths
      they fixed had been live — so treat the trajectory/fixture/tarball
      history as suspect until a scanner (e.g. `gitleaks` / `trufflehog`
      over **all refs**) proves otherwise. Any hit: rotate the secret first,
      then decide between history rewrite and staying private.
- [ ] **LICENSE coverage.** The root stays `UNLICENSED`/`private: true` (the
      proprietary wrapper); `packages/sdk` and `packages/protocol` each carry
      their MIT `LICENSE`. Verify the root `README.md` explains the split —
      what is MIT (the two packages) and what is all-rights-reserved
      (everything else) — **before** the flip, so the repo is not implicitly
      presented as fully open source.
- [ ] **CI secrets.** Audit `.github/workflows/*` and the repo's Actions
      settings for what a public repo changes: fork-PR runs must not receive
      secrets, no token or credential may reach logs, and any deploy/release
      keys should be scoped to protected branches/environments.

---

**Hard stop, restated:** publishing is irreversible, and the public flip is
even more so. Every step above is run **personally by the CEO** — an agent's
job ends at green dry-runs and this document.
