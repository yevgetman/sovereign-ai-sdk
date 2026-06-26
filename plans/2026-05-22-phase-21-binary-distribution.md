# Phase 21 M1 — Binary Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `sov` as installable compiled binaries for `darwin-arm64`, `darwin-x64`, and `linux-x64` via a separate public `sov-releases` GitHub repo + a one-line `curl | bash` installer, with the source repo staying private.

**Architecture:** Bun `--compile` produces a self-contained `sov` executable per platform; `go build` cross-compiles the `sov-tui` sibling binary; both ship in a tarball alongside the verbatim `bundle-default/` side-car directory. A new `scripts/release.ts` orchestrates locally (M1 manual; M2 automates via GHA later). `src/bundle/defaultBundle.ts` learns a binary-install discovery branch using `process.execPath`. `src/cli/upgrade.ts` detects binary mode and re-runs the public installer. A new public repo `github.com/yevgetman/sov-releases` carries `install.sh` + `LICENSE.txt` + GitHub Releases. No source is mirrored.

**Tech Stack:** Bun 1.2+ (compile target), Go 1.24+ (TUI cross-compile), bash/POSIX shell (installer), `gh` CLI (release uploads), GitHub Releases (artifact distribution).

**Spec:** [`specs/2026-05-21-binary-distribution-design.md`](specs/2026-05-21-binary-distribution-design.md) — 7 ADRs locked (P21-01..07). Read it first; this plan executes against it.

**Author decisions locked 2026-05-22:**
- GitHub owner: `yevgetman`
- First release tag: `v0.2.0`
- LICENSE.txt copyright holder: `Sovereign AI`

---

## File map

### Created in private repo

| Path | Purpose |
|---|---|
| `scripts/release.ts` | Local-only release pipeline: pre-flight checks → per-platform compile → tar → SHA256SUMS → `gh release create` |
| `README.binary.md` | Per-tarball user-facing README (copied into each platform tarball) |
| `docs/07-history/state/2026-05-22-phase-21-m1.md` | M1 close-out snapshot |

### Modified in private repo

| Path | Change |
|---|---|
| `src/bundle/defaultBundle.ts` | Extend `shippedBundlePath()` with binary-mode branch (try `process.execPath`-relative first, fall back to current `import.meta.url` walk) |
| `tests/bundle/defaultBundle.test.ts` | Add binary-mode resolution tests via a fake `execPath` shim |
| `src/cli/upgrade.ts` | Add binary-mode detection + branch that shells out to public `install.sh` |
| `tests/cli/upgrade.test.ts` | Add binary-mode detection tests + branch-selection tests via env/execPath shims |
| `package.json` | Version bump `0.1.0` → `0.2.0`; add `"release": "bun run scripts/release.ts"` script alias |
| `README.md` | Add "Binary install (recommended for non-developers)" section pointing at the public installer |
| `DECISIONS.md` | 2 new ADRs: P21-A (binary-mode asset discovery), P21-B (binary-mode upgrade detection) |
| `docs/06-testing/testing-log.md` | Smoke-pass entries (macOS + Linux); release attempt entry |
| `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` | Mark Phase 21 M1 as **complete** in the section that currently says "Awaiting plan + execution" |

### Created in new PUBLIC repo `github.com/yevgetman/sov-releases`

| Path | Purpose |
|---|---|
| `README.md` | Product description + install command + beta-tester onboarding |
| `LICENSE.txt` | Beta evaluation license (copyright "Sovereign AI") |
| `install.sh` | The public POSIX-shell installer |
| `CHANGELOG.md` | High-level per-release notes (no source diffs) |

Plus GitHub Releases: `v0.2.0` tag with `sov-darwin-arm64.tar.gz`, `sov-darwin-x64.tar.gz`, `sov-linux-x64.tar.gz`, `SHA256SUMS`.

---

## Task 0: Pre-flight — validate `bun build --compile` with `bun:sqlite`

**Why first:** Risk #1 in the spec. The runtime uses `bun:sqlite` for session persistence. If `--compile` mode can't embed it correctly, the whole plan needs rework. A 10-minute spike de-risks the rest.

**Files:**
- Create: `/tmp/sov-spike/spike.ts` (throwaway; not committed)

- [ ] **Step 1: Create a hello-world that touches bun:sqlite**

Create `/tmp/sov-spike/spike.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `sov-spike-${Date.now()}.db`);
const db = new Database(dbPath);
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
db.exec("INSERT INTO t (v) VALUES ('hello'), ('world')");
const rows = db.query('SELECT v FROM t ORDER BY id').all();
console.log(JSON.stringify(rows));
db.close();
```

- [ ] **Step 2: Compile + run on host**

```bash
cd /tmp/sov-spike
bun build --compile --target=bun-darwin-arm64 --outfile=spike-bin spike.ts
./spike-bin
```

Expected output: `[{"v":"hello"},{"v":"world"}]`

- [ ] **Step 3: Record result + clean up**

If pass: append a one-line note to your scratchpad ("Phase 21 spike: bun --compile + bun:sqlite works on darwin-arm64") and proceed to Task 1.

If fail: STOP. Capture the error. The plan needs a rework — likely either (a) extract the DB path to a runtime config + create at install time, or (b) ship the DB schema as a side-car migration the binary runs at first launch. Discuss with the author before continuing.

```bash
rm -rf /tmp/sov-spike
```

- [ ] **Step 4: Commit nothing** — the spike was scratch.

---

## Task 1: Asset discovery — `shippedBundlePath()` binary-mode branch (TDD)

**Files:**
- Modify: `src/bundle/defaultBundle.ts:43-51` (the `shippedBundlePath` function)
- Modify: `tests/bundle/defaultBundle.test.ts` (add binary-mode cases)

**What changes:** `shippedBundlePath()` currently walks up from `import.meta.url` to find `<repo>/bundle-default/`. In a Bun `--compile` binary, `import.meta.url` resolves to a virtual path inside the embedded filesystem — the walk produces a path that doesn't exist on disk. The fix prepends a `process.execPath`-relative discovery: look for `<dirname(dirname(execPath))>/bundle-default/index.yaml` first; if present, return it. Otherwise fall through to the existing `import.meta.url` branch (preserves source-mode behavior exactly).

To make this testable, the production function takes optional `execPath` and `metaUrl` overrides; production callers pass nothing, tests inject fake paths.

- [ ] **Step 1: Write the failing tests**

Edit `tests/bundle/defaultBundle.test.ts`. Add a new describe block AFTER the existing `describe('shippedBundlePath', ...)` block:

```typescript
describe('shippedBundlePath — binary install mode', () => {
  test('returns sibling bundle-default/ when execPath has one', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-binary-install-'));
    try {
      const binDir = join(root, 'bin');
      const bundleDir = join(root, 'bundle-default');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'index.yaml'), 'repo: binary-bundle\n');
      const fakeExec = join(binDir, 'sov');
      writeFileSync(fakeExec, '');
      const path = shippedBundlePath({ execPath: fakeExec });
      expect(path).toBe(bundleDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls through to source-mode resolver when no sibling bundle exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-no-binary-bundle-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeExec = join(binDir, 'sov');
      writeFileSync(fakeExec, '');
      // No bundle-default at root → binary branch misses → falls through to
      // import.meta.url walk → returns the real shipped bundle path.
      const path = shippedBundlePath({ execPath: fakeExec });
      expect(path).not.toBeNull();
      expect(path).toContain('bundle-default');
      // The real shipped bundle has an index.yaml.
      expect(existsSync(join(path ?? '', 'index.yaml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls through when execPath is unreadable / does not exist', () => {
    const path = shippedBundlePath({ execPath: '/does/not/exist/sov' });
    // The realpathSync on a missing path throws → caught → falls through.
    expect(path).not.toBeNull();
    expect(path).toContain('bundle-default');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test tests/bundle/defaultBundle.test.ts -t "binary install mode"
```

Expected: FAIL — production code doesn't accept the `{ execPath }` override yet.

- [ ] **Step 3: Implement the binary-mode branch**

Edit `src/bundle/defaultBundle.ts`. Update the file-header comment and replace the `shippedBundlePath` function:

Replace the file header comment (lines 1-13) with:

```typescript
// Phase 10.8 — default bundle resolver. Two-step fallthrough:
//
//   1. <harness-home>/default-bundle/  — user override location
//   2. <runtime-repo>/bundle-default/  — shipped default
//
// Phase 21 — binary-install mode resolves the shipped bundle via
// process.execPath FIRST (the Bun-compiled binary lives at
// e.g. ~/.sov/bin/sov; the bundle ships as a sibling
// ~/.sov/bundle-default/). When that check misses, falls through to the
// source-mode resolver (import.meta.url walk to the repo root). This
// preserves the source-mode behavior bit-for-bit.
//
// Phase 13.3 (B2) — adds isDefaultBundlePath() predicate for routing
// trajectory writes away from the stock bundle's tree.
```

Replace the `shippedBundlePath` function (lines 43-51) with:

```typescript
/** `<runtime-repo>/bundle-default/` (source mode) OR
 *  `<dirname(execPath)/../bundle-default/` (binary install mode).
 *
 *  Binary mode is tried first. The check is content-based (existsSync
 *  on index.yaml) so it works for any install layout, not just ~/.sov/.
 *
 *  Returns null only when BOTH resolvers fail (rare; would mean a broken
 *  install with no bundle-default anywhere reachable).
 *
 *  The optional overrides are test seams: production passes nothing. */
export function shippedBundlePath(
  opts: { execPath?: string; metaUrl?: string } = {},
): string | null {
  // Binary install mode: process.execPath points to the on-disk
  // compiled binary (e.g. ~/.sov/bin/sov). Look for a sibling
  // bundle-default/ at <dirname(dirname(execPath))>/bundle-default.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = dirname(realpathSync(execPath));
    const candidate = join(dirname(execDir), 'bundle-default');
    if (existsSync(join(candidate, 'index.yaml'))) return candidate;
  } catch {
    // realpath threw (missing file, permission, etc.) — fall through.
  }

  // Source mode: walk up from this file's URL.
  // For `bun src/main.ts` or `bun install -g` installs, the binary
  // branch above misses by design (process.execPath is the bun
  // executable itself, with no bundle-default sibling) so we land here.
  try {
    const metaUrl = opts.metaUrl ?? import.meta.url;
    const realMain = realpathSync(fileURLToPath(metaUrl));
    // src/bundle/defaultBundle.ts → walk up three levels to the repo root
    return join(dirname(dirname(dirname(realMain))), 'bundle-default');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test tests/bundle/defaultBundle.test.ts
```

Expected: ALL pass — the new binary-mode cases AND the existing source-mode cases (the latter exercise the fallthrough since they don't pass `execPath`).

- [ ] **Step 5: Run the full suite to verify no regressions**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: lint clean (carrying same 2 pre-existing warnings), typecheck clean, test count goes from 1955 → 1958 (3 new cases), 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/bundle/defaultBundle.ts tests/bundle/defaultBundle.test.ts
git commit -m "$(cat <<'EOF'
feat(bundle): binary-install asset discovery for shippedBundlePath

Phase 21 M1 prep: extend shippedBundlePath() with a process.execPath-based
branch tried before the source-mode import.meta.url walk. Bun-compiled
binaries living at e.g. ~/.sov/bin/sov now resolve the side-car
~/.sov/bundle-default/ correctly; source-mode behavior unchanged.

Production callers pass no args (override fields are test seams).
EOF
)"
```

---

## Task 2: `sov upgrade` binary-mode detection (TDD)

**Files:**
- Modify: `src/cli/upgrade.ts`
- Modify: `tests/cli/upgrade.test.ts`

**What changes:** `sov upgrade` currently shells out to `bun install -g <ssh-url>`. That doesn't work for binary installs (no Bun on the user's machine, no access to the private SSH URL). The fix: detect binary mode by checking whether `process.execPath` is under `${homedir()}/.sov/bin/`; if yes, shell out to `bash -c "curl -fsSL <public-installer-url> | bash"`. Source mode is unchanged.

Constants for the public installer URL move into the file alongside `DEFAULT_INSTALL_URL`.

- [ ] **Step 1: Write the failing tests**

Edit `tests/cli/upgrade.test.ts`. Add these imports to the existing import block:

```typescript
import {
  BINARY_INSTALLER_URL,
  DEFAULT_INSTALL_URL,
  PACKAGE_NAME,
  buildUpgradeCommands,
  detectInstallMode,
  runUpgrade,
} from '../../src/cli/upgrade.js';
```

Add a new describe block at the END of the file:

```typescript
describe('detectInstallMode', () => {
  test('returns "binary" when execPath is under ~/.sov/bin/', () => {
    expect(detectInstallMode({ execPath: '/home/alice/.sov/bin/sov', homedir: '/home/alice' })).toBe('binary');
  });

  test('returns "binary" when execPath is a deeper path under ~/.sov/bin/', () => {
    expect(detectInstallMode({ execPath: '/Users/julie/.sov/bin/sov', homedir: '/Users/julie' })).toBe('binary');
  });

  test('returns "source" when execPath is the Bun runtime', () => {
    expect(detectInstallMode({ execPath: '/Users/julie/.bun/bin/bun', homedir: '/Users/julie' })).toBe('source');
  });

  test('returns "source" when execPath is a project-local node_modules entry', () => {
    expect(detectInstallMode({ execPath: '/Users/julie/code/sov/node_modules/.bin/bun', homedir: '/Users/julie' })).toBe('source');
  });

  test('returns "source" when execPath is unrelated', () => {
    expect(detectInstallMode({ execPath: '/usr/local/bin/bun', homedir: '/Users/julie' })).toBe('source');
  });
});

describe('buildUpgradeCommands — binary mode', () => {
  test('returns single bash -c curl|bash command for binary mode', () => {
    const cmds = buildUpgradeCommands({ mode: 'binary' }, {});
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.[0]).toBe('bash');
    expect(cmds[0]?.[1]).toBe('-c');
    expect(cmds[0]?.[2]).toContain('curl');
    expect(cmds[0]?.[2]).toContain(BINARY_INSTALLER_URL);
    expect(cmds[0]?.[2]).toContain('| bash');
  });

  test('binary mode ignores skipUninstall / installUrl / ref / purgeCache', () => {
    const cmds = buildUpgradeCommands(
      {
        mode: 'binary',
        skipUninstall: true,
        installUrl: 'git+ssh://git@example.com/fork.git',
        ref: 'v0.3.0',
      },
      {},
    );
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.[2]).toContain(BINARY_INSTALLER_URL);
    expect(cmds[0]?.[2]).not.toContain('fork.git');
    expect(cmds[0]?.[2]).not.toContain('v0.3.0');
  });

  test('source mode (default) preserves existing two-command behavior', () => {
    const cmds = buildUpgradeCommands({ mode: 'source' }, {});
    expect(cmds.length).toBe(2);
    expect(cmds[0]).toEqual(['bun', 'uninstall', '-g', PACKAGE_NAME]);
    expect(cmds[1]).toEqual(['bun', 'install', '-g', DEFAULT_INSTALL_URL]);
  });
});

describe('runUpgrade — binary mode dry-run', () => {
  test('dry-run prints the curl|bash command and does not purge cache', () => {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const out = { write: (c: string) => { chunks.push(c); return true; } } as unknown as NodeJS.WritableStream;
    const err = { write: (c: string) => { errChunks.push(c); return true; } } as unknown as NodeJS.WritableStream;
    const result = runUpgrade({ mode: 'binary', dryRun: true }, out, err);
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toContain('would run: bash -c');
    expect(chunks.join('')).toContain(BINARY_INSTALLER_URL);
    // Binary mode doesn't manage Bun's cache.
    expect(chunks.join('')).not.toContain('would purge');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test tests/cli/upgrade.test.ts -t "binary mode"
bun test tests/cli/upgrade.test.ts -t "detectInstallMode"
```

Expected: FAIL on multiple cases — `detectInstallMode` doesn't exist, `BINARY_INSTALLER_URL` doesn't exist, `mode` field on `UpgradeOpts` not recognized.

- [ ] **Step 3: Implement the binary-mode branch**

Edit `src/cli/upgrade.ts`.

Add this export AFTER the `PACKAGE_NAME` export (around line 39):

```typescript
/** Public installer URL for binary-mode upgrade. Constant — the URL is
 *  the contract with sov-releases. If we ever rename the public repo,
 *  this constant moves with it. */
export const BINARY_INSTALLER_URL =
  'https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh';

/** Install-mode discriminator. 'binary' = installed under ~/.sov/bin/;
 *  'source' = anything else (Bun global install, bun src/main.ts dev
 *  loop, project-local bun, etc.). */
export type InstallMode = 'binary' | 'source';

/** Pure-function predicate for which upgrade strategy to use. Both
 *  inputs are arguments so tests can drive without touching real env. */
export function detectInstallMode(input: {
  execPath: string;
  homedir: string;
}): InstallMode {
  const binaryRoot = join(input.homedir, '.sov', 'bin') + '/';
  // realpath would be more correct but execPath is already canonical
  // from Bun's standpoint, and the install layout is fully under our
  // control. Prefix-string check is sufficient.
  return input.execPath.startsWith(binaryRoot) ? 'binary' : 'source';
}
```

Add a `mode?: InstallMode` field to the `UpgradeOpts` type. Find the type block (around line 41-68) and insert this field RIGHT BEFORE the `/** Test seam — overrides DEFAULT_INSTALL_URL` field:

```typescript
  /** Override install-mode detection. Default: auto-detect from
   *  process.execPath via detectInstallMode(). Pass 'source' to force
   *  the legacy bun-install flow even on binary installs (escape
   *  hatch); pass 'binary' to force the public-installer flow even on
   *  source installs (rarely useful — would re-download Bun + binary). */
  mode?: InstallMode;
```

Replace the `buildUpgradeCommands` function (lines 88-97) with this expanded version:

```typescript
/** Pure helper: produce the argv list(s) we'd spawn.
 *
 *  Binary mode: single command, `bash -c "curl ... | bash"`.
 *  Source mode: [uninstall, install] (or just [install] if skipUninstall).
 *
 *  Mode is taken from opts.mode if set, else auto-detected from
 *  process.execPath + homedir at call time. */
export function buildUpgradeCommands(
  opts: UpgradeOpts = {},
  env: NodeJS.ProcessEnv = process.env,
): string[][] {
  const mode = opts.mode ?? detectInstallMode({
    execPath: process.execPath,
    homedir: homedir(),
  });

  if (mode === 'binary') {
    return [['bash', '-c', `curl -fsSL ${BINARY_INSTALLER_URL} | bash`]];
  }

  const base = opts.installUrl ?? env.SOV_UPGRADE_URL ?? DEFAULT_INSTALL_URL;
  const url = opts.ref ? `${base}#${opts.ref}` : base;
  const install = ['bun', 'install', '-g', url];
  if (opts.skipUninstall === true) return [install];
  return [['bun', 'uninstall', '-g', PACKAGE_NAME], install];
}
```

Update `shouldPurgeCache` (around line 72) to short-circuit binary mode. Replace the function with:

```typescript
/** Resolve the effective cache-purge decision from the opt flags.
 *  Binary mode: never purge (Bun's cache is irrelevant). Source mode:
 *  default purge; explicit purgeCache:false OR keepCache:true wins. */
export function shouldPurgeCache(opts: UpgradeOpts): boolean {
  const mode = opts.mode ?? detectInstallMode({
    execPath: process.execPath,
    homedir: homedir(),
  });
  if (mode === 'binary') return false;
  if (opts.keepCache === true) return false;
  if (opts.purgeCache === false) return false;
  return true;
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
bun test tests/cli/upgrade.test.ts -t "binary mode"
bun test tests/cli/upgrade.test.ts -t "detectInstallMode"
```

Expected: ALL pass.

- [ ] **Step 5: Run the full upgrade test file to verify no regressions**

```bash
bun test tests/cli/upgrade.test.ts
```

Expected: existing tests still pass — they don't pass `mode`, so they auto-detect; in the test process `process.execPath` is the Bun runtime path (not under `~/.sov/bin/`) so detection returns `'source'` and the legacy branch runs unchanged.

- [ ] **Step 6: Run the full suite**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: lint clean, typecheck clean, count rises by ~9 (the new cases), 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/cli/upgrade.ts tests/cli/upgrade.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): sov upgrade detects binary mode + re-runs public installer

Phase 21 M1 prep: detectInstallMode() classifies the running process by
whether execPath is under ~/.sov/bin/. Binary mode shells out to
`bash -c "curl -fsSL <BINARY_INSTALLER_URL> | bash"`; source mode
preserves the existing bun-install-g flow exactly. Cache purge is
short-circuited in binary mode (Bun's cache is irrelevant there).
EOF
)"
```

---

## Task 3: Stand up the public `sov-releases` repo

**Why this comes before `scripts/release.ts`:** the release script's final step is `gh release create --repo yevgetman/sov-releases`. The repo must exist and the gh CLI must be authenticated against it before the script can succeed.

**What this is:** completely out of the private repo tree. Manual one-time setup. Files committed to a new GitHub repo, not to this repo.

- [ ] **Step 1: Create the public repo on GitHub**

```bash
gh repo create yevgetman/sov-releases \
  --public \
  --description "Binary releases of Sovereign AI Harness — beta evaluation distribution" \
  --confirm
```

Expected output: `https://github.com/yevgetman/sov-releases`.

- [ ] **Step 2: Clone it locally**

```bash
cd /tmp
git clone git@github.com:yevgetman/sov-releases.git
cd sov-releases
```

- [ ] **Step 3: Write `LICENSE.txt`**

Create `LICENSE.txt`:

```
Sovereign AI Harness — Beta Evaluation License

Copyright © 2026 Sovereign AI. All rights reserved.

This software is provided to you for personal evaluation and testing
purposes only. You may install and run it on machines you control. You
may not:

  - Redistribute, resell, sublicense, or share the software or any
    portion of it
  - Reverse-engineer, decompile, or attempt to extract source code
  - Use the software in production systems or commercial offerings
  - Use the software to train machine-learning models

The software is provided "as is," without warranty of any kind. The
author is not liable for any damages arising from its use.

This license terminates automatically on any breach. On termination
you must delete all copies.

Contact yevgetman@gmail.com for any other usage.
```

- [ ] **Step 4: Write `README.md`**

Create `README.md`:

````markdown
# Sovereign AI Harness — Binary Releases

This repository distributes compiled binaries of the **Sovereign AI Harness**
(`sov`) for personal evaluation and testing.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash
```

This script:

1. Detects your platform (`darwin-arm64`, `darwin-x64`, or `linux-x64`).
2. Downloads the latest release tarball + verifies its SHA256 checksum.
3. Installs to `~/.sov/` (no `sudo` required).
4. Appends `~/.sov/bin` to your shell's `PATH` (zsh / bash auto-detected).

Re-run the same command anytime to upgrade.

## What you get

- `sov` — the Sovereign AI agent runtime CLI
- `sov-tui` — the bundled Bubble Tea TUI binary
- `bundle-default/` — the default agent bundle (skills, agents, prompts)

## Supported platforms (day-one)

| Platform | Status |
|---|---|
| macOS Apple Silicon (`darwin-arm64`) | Primary |
| macOS Intel (`darwin-x64`) | Supported |
| Linux x86_64 (`linux-x64`) | Supported |
| Windows | Not supported (Unix-isms in the runtime) |
| Linux ARM64 | Not supported (request via email) |

## macOS first-run

Unsigned binaries downloaded via `curl` get quarantined by Gatekeeper.
First run shows "macOS cannot verify the developer." Dismiss permanently
with:

```bash
xattr -d com.apple.quarantine ~/.sov/bin/sov ~/.sov/bin/sov-tui
```

(A future release will be signed + notarized; this step won't be needed.)

## License

Beta evaluation license — see [`LICENSE.txt`](LICENSE.txt). NOT open
source. Source code is not distributed.

## Support

This is a personal beta. For issues or feedback, contact
**yevgetman@gmail.com**.
````

- [ ] **Step 5: Write `CHANGELOG.md`**

Create `CHANGELOG.md`:

```markdown
# Changelog

## v0.2.0 — 2026-05-22

First public binary release. Phase 21 M1.

- `sov` CLI (TypeScript runtime, Bun-compiled, ~80 MB)
- `sov-tui` (Go, Bubble Tea, ~10 MB)
- Default agent bundle (skills + agents + prompts)
- Platforms: darwin-arm64, darwin-x64, linux-x64
- One-line installer at `install.sh`
- `sov upgrade` re-runs the installer in binary mode
```

- [ ] **Step 6: Write `install.sh`**

Create `install.sh`:

```bash
#!/usr/bin/env bash
# Sovereign AI Harness — public installer
# Phase 21 M1 — re-runnable; idempotent; atomic install/upgrade.

set -euo pipefail

OWNER="yevgetman"
REPO="sov-releases"
INSTALL_ROOT="${HOME}/.sov"
INSTALL_TMP="${HOME}/.sov.tmp.$$"

die() { printf 'sov-install: %s\n' "$1" >&2; exit 1; }
note() { printf 'sov-install: %s\n' "$1"; }

# ---------- detect platform ----------
detect_target() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "${uname_s}-${uname_m}" in
    Darwin-arm64)  echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Linux-x86_64)  echo "linux-x64" ;;
    *)
      die "unsupported platform: ${uname_s} ${uname_m}. Supported: darwin-arm64, darwin-x64, linux-x64."
      ;;
  esac
}
TARGET="$(detect_target)"
note "platform: ${TARGET}"

# ---------- discover latest release ----------
note "querying latest release..."
LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest")"
TAG="$(echo "${LATEST_JSON}" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "${TAG}" ] && die "could not parse latest release tag from GitHub API"
note "latest tag: ${TAG}"

ASSET_URL="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/sov-${TARGET}.tar.gz"
SUMS_URL="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/SHA256SUMS"

# ---------- download tarball + checksum ----------
TMPDIR="$(mktemp -d)"
trap "rm -rf '${TMPDIR}'" EXIT
TARBALL="${TMPDIR}/sov-${TARGET}.tar.gz"
SUMS="${TMPDIR}/SHA256SUMS"

note "downloading tarball..."
curl -fLO --output-dir "${TMPDIR}" "${ASSET_URL}"

note "downloading checksums..."
curl -fsSL -o "${SUMS}" "${SUMS_URL}"

# ---------- verify checksum ----------
EXPECTED="$(grep "sov-${TARGET}.tar.gz" "${SUMS}" | awk '{print $1}')"
[ -z "${EXPECTED}" ] && die "no checksum line for sov-${TARGET}.tar.gz in SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TARBALL}" | awk '{print $1}')"
else
  # macOS ships shasum, not sha256sum
  ACTUAL="$(shasum -a 256 "${TARBALL}" | awk '{print $1}')"
fi

[ "${EXPECTED}" != "${ACTUAL}" ] && die "checksum mismatch — expected ${EXPECTED}, got ${ACTUAL}"
note "checksum ok"

# ---------- extract atomically ----------
note "extracting to ${INSTALL_ROOT}..."
rm -rf "${INSTALL_TMP}"
mkdir -p "${INSTALL_TMP}"
tar -xzf "${TARBALL}" -C "${INSTALL_TMP}"

if [ -d "${INSTALL_ROOT}" ]; then
  BACKUP="${INSTALL_ROOT}.bak.$(date +%s)"
  note "backing up previous install to ${BACKUP}"
  mv "${INSTALL_ROOT}" "${BACKUP}"
fi
mv "${INSTALL_TMP}" "${INSTALL_ROOT}"

# ---------- mark executables ----------
chmod +x "${INSTALL_ROOT}/bin/sov" "${INSTALL_ROOT}/bin/sov-tui"

# ---------- write version marker ----------
echo "${TAG}" > "${INSTALL_ROOT}/version"

# ---------- PATH append (idempotent) ----------
PATH_LINE='export PATH="$HOME/.sov/bin:$PATH"'
case "$(basename "${SHELL:-}")" in
  zsh)  RC="${HOME}/.zshrc" ;;
  bash) RC="${HOME}/.bashrc" ;;
  *)    RC="" ;;
esac

if [ -n "${RC}" ]; then
  if [ -f "${RC}" ] && grep -Fq "${PATH_LINE}" "${RC}"; then
    note "PATH already set in ${RC}"
  else
    echo "" >> "${RC}"
    echo "# Added by sov installer ($(date -u +%FT%TZ))" >> "${RC}"
    echo "${PATH_LINE}" >> "${RC}"
    note "appended PATH to ${RC} — open a new shell or run: source ${RC}"
  fi
else
  note "unknown shell ($SHELL) — add this to your shell rc manually:"
  printf '  %s\n' "${PATH_LINE}"
fi

# ---------- macOS quarantine note ----------
if [ "${TARGET#darwin-}" != "${TARGET}" ]; then
  note "macOS note: first run may show 'macOS cannot verify the developer.'"
  note "to dismiss permanently:"
  printf '  xattr -d com.apple.quarantine %s/bin/sov %s/bin/sov-tui\n' "${INSTALL_ROOT}" "${INSTALL_ROOT}"
fi

# ---------- done ----------
note "installed ${TAG} to ${INSTALL_ROOT}"
note "run: sov --version"
```

- [ ] **Step 7: Commit + push the public repo**

```bash
chmod +x install.sh
git add LICENSE.txt README.md CHANGELOG.md install.sh
git commit -m "feat: initial sov-releases scaffold — README + LICENSE + install.sh + CHANGELOG"
git push origin main
```

- [ ] **Step 8: Verify install.sh is fetchable from raw.githubusercontent.com**

```bash
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | head -20
```

Expected: the first 20 lines of install.sh come back (header + `OWNER` etc.). Confirms public readability and the canonical URL constant in `src/cli/upgrade.ts` is correct.

- [ ] **Step 9: cd back to the private repo before continuing**

```bash
cd /Users/julie/code/sovereign-ai-harness
```

---

## Task 4: Author `scripts/release.ts`

**Files:**
- Create: `scripts/release.ts`
- Modify: `package.json` (add `"release": "bun run scripts/release.ts"` script)

**What it does:** local-only orchestrator. Compiles + cross-compiles per platform → tars → SHA256SUMS → `gh release create`. Has a `--dry-run` mode that skips upload + tag-push. Enforces pre-flight: clean git, on master, lint+typecheck+test green, `gh` auth ok, Bun + Go versions.

- [ ] **Step 1: Write the release script**

Create `scripts/release.ts`:

```typescript
// scripts/release.ts — Phase 21 M1 manual release pipeline.
//
// Invoked as: bun run release v0.2.0 [--dry-run]
//
// Builds per-platform tarballs and uploads them to the public
// sov-releases repo via gh release create. Pre-flight enforces a clean
// git tree, master branch, green tests, and gh auth. Dry-run produces
// all artifacts under build/release/<tag>/ but skips git-tag-push +
// upload — useful for verifying artifacts before committing to a tag.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';

const OWNER = 'yevgetman';
const PUBLIC_REPO = 'sov-releases';
const ROOT = resolve(import.meta.dir, '..');

type Target = {
  name: 'darwin-arm64' | 'darwin-x64' | 'linux-x64';
  bunTarget: string;
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
};

const TARGETS: Target[] = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
];

function die(msg: string): never {
  process.stderr.write(`release: ${msg}\n`);
  exit(1);
}

function note(msg: string): void {
  process.stdout.write(`release: ${msg}\n`);
}

function run(bin: string, args: string[], opts: { cwd?: string } = {}): void {
  const result = spawnSync(bin, args, { stdio: 'inherit', cwd: opts.cwd ?? ROOT });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
}

function capture(bin: string, args: string[], opts: { cwd?: string } = {}): string {
  const result = spawnSync(bin, args, { cwd: opts.cwd ?? ROOT });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
  return result.stdout.toString().trim();
}

function sha256(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function preflight(version: string): void {
  note('pre-flight checks...');

  // 1. Version format
  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    die(`bad version "${version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`);
  }

  // 2. Clean git tree
  const status = capture('git', ['status', '--porcelain']);
  if (status !== '') die(`git working tree not clean:\n${status}`);

  // 3. On master
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'master') die(`not on master (on "${branch}")`);

  // 4. Pre-commit gate
  note('running lint...');
  run('bun', ['run', 'lint']);
  note('running typecheck...');
  run('bun', ['run', 'typecheck']);
  note('running test...');
  run('bun', ['run', 'test']);

  // 5. gh CLI authenticated for sov-releases
  const ghStatus = spawnSync('gh', ['auth', 'status']);
  if (ghStatus.status !== 0) die('gh CLI not authenticated — run: gh auth login');

  // 6. Bun version ≥1.2.0
  const bunVer = capture('bun', ['--version']);
  if (!satisfies(bunVer, '1.2.0')) die(`bun version too old: ${bunVer} (need ≥1.2.0)`);

  // 7. Go version ≥1.24
  const goVerLine = capture('go', ['version']); // "go version go1.24.0 darwin/arm64"
  const goVer = goVerLine.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? '0';
  if (!satisfies(goVer, '1.24.0')) die(`go version too old: ${goVer} (need ≥1.24)`);

  note('pre-flight ok');
}

function satisfies(have: string, need: string): boolean {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10));
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

function buildOne(target: Target, version: string, releaseDir: string): string {
  const stageDir = join(releaseDir, target.name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'bin'), { recursive: true });

  // 1. Bun compile
  note(`[${target.name}] bun build --compile...`);
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${join(stageDir, 'bin', 'sov')}`,
    'src/main.ts',
  ]);

  // 2. Go cross-compile TUI
  note(`[${target.name}] go build sov-tui (${target.goos}/${target.goarch})...`);
  run(
    'go',
    [
      'build',
      '-o',
      join(stageDir, 'bin', 'sov-tui'),
      './cmd/sov-tui',
    ],
    {
      cwd: join(ROOT, 'packages', 'tui'),
    },
  );
  // env-prefix for cross-compile
  const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch };
  const goResult = spawnSync('go', ['build', '-o', join(stageDir, 'bin', 'sov-tui'), './cmd/sov-tui'], {
    cwd: join(ROOT, 'packages', 'tui'),
    env,
    stdio: 'inherit',
  });
  if (goResult.status !== 0) die(`go build for ${target.name} → exit ${goResult.status}`);

  // 3. Copy bundle-default/
  note(`[${target.name}] copying bundle-default/...`);
  cpSync(join(ROOT, 'bundle-default'), join(stageDir, 'bundle-default'), { recursive: true });

  // 4. Copy LICENSE.txt from the public repo clone
  const publicLicense = process.env.SOV_RELEASES_PATH
    ? join(process.env.SOV_RELEASES_PATH, 'LICENSE.txt')
    : '';
  if (publicLicense !== '' && existsSync(publicLicense)) {
    cpSync(publicLicense, join(stageDir, 'LICENSE.txt'));
  } else {
    die(
      'LICENSE.txt not found. Set SOV_RELEASES_PATH=/path/to/sov-releases ' +
        'or clone it next to this repo.',
    );
  }

  // 5. Copy README.binary.md → README.md inside the tarball
  cpSync(join(ROOT, 'README.binary.md'), join(stageDir, 'README.md'));

  // 6. Write version file inside the tarball (mirrors what install.sh writes)
  writeFileSync(join(stageDir, 'version'), version + '\n');

  // 7. Tar
  const tarball = join(releaseDir, `sov-${target.name}.tar.gz`);
  note(`[${target.name}] tarring → ${tarball}`);
  run('tar', ['-czf', tarball, '-C', stageDir, '.']);
  const size = statSync(tarball).size;
  note(`[${target.name}] tarball size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return tarball;
}

function writeSums(tarballs: string[], releaseDir: string): string {
  const lines = tarballs
    .map((p) => {
      const hash = sha256(p);
      const name = p.substring(p.lastIndexOf('/') + 1);
      return `${hash}  ${name}`;
    })
    .join('\n');
  const out = join(releaseDir, 'SHA256SUMS');
  writeFileSync(out, lines + '\n');
  note(`wrote ${out}`);
  return out;
}

function tagAndPush(version: string): void {
  note(`tagging ${version}...`);
  run('git', ['tag', version]);
  run('git', ['push', 'origin', version]);
}

function uploadRelease(version: string, assets: string[]): void {
  note(`uploading to gh release ${version}...`);
  const args = [
    'release',
    'create',
    version,
    '--repo',
    `${OWNER}/${PUBLIC_REPO}`,
    '--title',
    `Sovereign AI Harness ${version}`,
    '--notes',
    `Binary release ${version}. See CHANGELOG.md in the public repo.`,
    ...assets,
  ];
  run('gh', args);
  note(`released: https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}`);
}

// ---------- main ----------

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!version) {
  die('usage: bun run release v0.x.y [--dry-run]');
}

preflight(version);

const releaseDir = join(ROOT, 'build', 'release', version);
mkdirSync(releaseDir, { recursive: true });

const tarballs: string[] = [];
for (const target of TARGETS) {
  tarballs.push(buildOne(target, version, releaseDir));
}
const sums = writeSums(tarballs, releaseDir);

if (dryRun) {
  note(`dry-run complete. Artifacts in ${releaseDir}`);
  note('skipped: git tag/push, gh release create');
  exit(0);
}

tagAndPush(version);
uploadRelease(version, [...tarballs, sums]);
note('done.');
```

- [ ] **Step 2: Add the script alias to package.json**

Edit `package.json`. In the `"scripts"` block, add `"release"` after `"chat"`:

```json
"release": "bun run scripts/release.ts",
```

- [ ] **Step 3: Bump version**

Edit `package.json`. Change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 4: Verify script is syntactically valid + the dry-run pre-flight runs**

This is NOT a real release run yet — it just confirms the script loads, the pre-flight functions execute, and we'd be ready to compile if we wanted to.

```bash
bun run typecheck
```

Expected: clean (the script's strict TS types catch any wiring issues).

- [ ] **Step 5: Commit the script + version bump (do NOT run a release yet)**

```bash
git add scripts/release.ts package.json
git commit -m "$(cat <<'EOF'
feat(release): Phase 21 M1 release script + version bump to 0.2.0

scripts/release.ts orchestrates the local manual release pipeline:
per-platform Bun --compile + Go cross-compile + tar + SHA256SUMS +
gh release create against yevgetman/sov-releases. Pre-flight enforces
clean git, on master, green pre-commit gate, gh auth, Bun ≥1.2, Go ≥1.24.

--dry-run produces all artifacts under build/release/<tag>/ without
tagging or uploading — used for pre-release verification.

Version bumped 0.1.0 → 0.2.0 to identify the binary-distribution
milestone. SOV_RELEASES_PATH env var must point at the local clone of
the public repo (where LICENSE.txt is sourced).
EOF
)"
```

---

## Task 5: Author `README.binary.md`

**Files:**
- Create: `README.binary.md`

**What it is:** the README copied into every platform tarball as the tarball-root `README.md`. Tells a beta user what they got and how to verify it.

- [ ] **Step 1: Write the file**

Create `README.binary.md`:

````markdown
# Sovereign AI Harness — binary install

This tarball contains a compiled distribution of `sov`:

- `bin/sov` — the agent runtime CLI (Bun-compiled standalone)
- `bin/sov-tui` — the Bubble Tea TUI sibling binary
- `bundle-default/` — the default agent bundle
- `version` — the installed release tag
- `LICENSE.txt` — beta evaluation license
- `README.md` — this file

If you got here via `curl ... | bash` the installer already placed everything
under `~/.sov/` and added `~/.sov/bin` to your `PATH`. Run:

```bash
sov --version
```

You should see the release tag. Then run:

```bash
sov
```

The interactive TUI starts up.

## Upgrade

```bash
sov upgrade
```

This re-runs the public installer, fetching the latest release. Subsequent
upgrades are idempotent.

## Uninstall

```bash
rm -rf ~/.sov
# then remove the PATH line from ~/.zshrc or ~/.bashrc
```

## Support

This is a personal beta. For issues or feedback: **yevgetman@gmail.com**.
````

- [ ] **Step 2: Commit**

```bash
git add README.binary.md
git commit -m "docs: README.binary.md — per-tarball user-facing readme"
```

---

## Task 6: Cut v0.2.0 release

**Files:** none touched in the private repo for this task (the release script is the actor).

**What this is:** run the actual release pipeline against `v0.2.0`. Produces the three tarballs + SHA256SUMS, tags master, uploads to GitHub Releases.

- [ ] **Step 1: Verify the public repo clone path is set**

```bash
export SOV_RELEASES_PATH="/tmp/sov-releases"
ls "${SOV_RELEASES_PATH}/LICENSE.txt"
```

Expected: file exists (you cloned it in Task 3 step 2).

- [ ] **Step 2: Dry-run first**

```bash
bun run release v0.2.0 --dry-run
```

Expected: pre-flight passes; three tarballs land under `build/release/v0.2.0/`; `SHA256SUMS` is written; the script prints "skipped: git tag/push, gh release create". Total wall time ~10 minutes.

- [ ] **Step 3: Inspect each tarball**

```bash
for t in darwin-arm64 darwin-x64 linux-x64; do
  echo "=== ${t} ==="
  tar -tzf build/release/v0.2.0/sov-${t}.tar.gz | head -20
done
```

Expected for each: `bin/sov`, `bin/sov-tui`, `bundle-default/index.yaml`, `bundle-default/...`, `LICENSE.txt`, `README.md`, `version`.

- [ ] **Step 4: Verify the host-platform binary runs**

```bash
./build/release/v0.2.0/darwin-arm64/bin/sov --version
```

Expected: prints the git SHA (per backlog #37 fix). If it errors, STOP — the pre-flight passed but the runtime can't boot; investigate before tagging.

- [ ] **Step 5: Run the real release**

```bash
bun run release v0.2.0
```

Expected: same as dry-run, plus `git tag v0.2.0` + `git push origin v0.2.0` + `gh release create`. Final line: "released: https://github.com/yevgetman/sov-releases/releases/tag/v0.2.0".

- [ ] **Step 6: Verify the release is live**

```bash
gh release view v0.2.0 --repo yevgetman/sov-releases
```

Expected: the release page shows three tarballs + SHA256SUMS as assets.

- [ ] **Step 7: Commit nothing** — the release pipeline doesn't produce any new private-repo files (build outputs are gitignored; if `build/` isn't in `.gitignore` yet, add it here).

```bash
# Verify build/ is ignored
git status
```

If `build/release/v0.2.0/` appears in untracked files, add `/build/` to `.gitignore`:

```bash
echo "/build/" >> .gitignore
git add .gitignore
git commit -m "chore: gitignore release build dir"
```

---

## Task 7: macOS smoke test

**Files:** none in private repo; appends to `docs/06-testing/testing-log.md` in Task 12.

- [ ] **Step 1: Wipe any existing `~/.sov/`**

```bash
mv ~/.sov ~/.sov.pre-smoke.$(date +%s) 2>/dev/null || true
```

- [ ] **Step 2: Run the public installer**

```bash
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash
```

Expected output covers: platform detection (`darwin-arm64`), tag query, download, checksum ok, extract, version write, PATH append to `~/.zshrc`, macOS quarantine note.

- [ ] **Step 3: Open a new shell and verify**

```bash
exec zsh -l
which sov
sov --version
```

Expected: `~/.sov/bin/sov`, and the version output matches the release tag.

- [ ] **Step 4: Launch the TUI**

```bash
sov
```

Expected: splash with model + provider, prompt appears, no errors. Type `/help` to confirm slash commands load. Type `exit` (or Ctrl+C twice) to leave.

- [ ] **Step 5: Verify `sov upgrade` detects binary mode**

```bash
sov upgrade --help    # if --help is implemented
sov upgrade           # should re-run install.sh (no-op since we're already latest)
```

Expected: console shows the `bash -c curl ... | bash` invocation; install.sh re-runs; outputs "installed v0.2.0 to ~/.sov" again (idempotent).

- [ ] **Step 6: Capture the result** — record pass/fail with brief notes; will be written into the testing log in Task 12.

---

## Task 8: Linux smoke test (Docker)

**Files:** none in private repo.

**Setup:** uses `ubuntu:22.04` Docker image — same as the target most beta users will run.

- [ ] **Step 1: Launch a clean Ubuntu container**

```bash
docker run --rm -it --platform linux/amd64 ubuntu:22.04 bash
```

- [ ] **Step 2: Inside the container — install minimal deps + run installer**

```bash
apt-get update && apt-get install -y curl ca-certificates
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash
```

Expected: detects `linux-x64`, downloads, checksum ok, extracts to `/root/.sov/`, PATH appended to `/root/.bashrc` (or unknown-shell message if SHELL is unset).

- [ ] **Step 3: Verify**

```bash
source ~/.bashrc 2>/dev/null || export PATH="$HOME/.sov/bin:$PATH"
sov --version
```

Expected: prints the tag.

- [ ] **Step 4: Verify TUI starts (test against a real provider if API key is convenient; otherwise just check splash + clean exit)**

```bash
sov
# observe splash; type /help; exit cleanly
```

Note: the container won't have ANTHROPIC_API_KEY etc.; that's fine for smoke purposes — boot + splash + slash-command list are enough.

- [ ] **Step 5: Exit container**

```bash
exit  # leaves the container; --rm cleans it up
```

- [ ] **Step 6: Capture result** — same as Task 7.

---

## Task 9: Write the two implementation ADRs

**Files:**
- Modify: `DECISIONS.md`

**What this records:** the two load-bearing design choices in the runtime-side changes from Tasks 1 + 2. Phase-prefixed `P21-A` and `P21-B` (the existing scheme uses milestone prefixes; Phase 21 doesn't have milestones, so we use suffix letters).

- [ ] **Step 1: Read the existing DECISIONS.md to see latest ADR**

```bash
grep -n "^## ADR" /Users/julie/code/sovereign-ai-harness/DECISIONS.md | head -3
```

(So you know which section to insert above.)

- [ ] **Step 2: Insert two new ADRs at the TOP of the file (after the intro paragraph)**

Edit `DECISIONS.md`. After the intro paragraph (ending at line ~3 — `## ADR M8-01 — Router-mode...` starts at line 5), insert these two ADRs:

```markdown
## ADR P21-A — Binary-install asset discovery via `process.execPath`, source-mode walk as fallback

Decision: `shippedBundlePath()` in `src/bundle/defaultBundle.ts` tries a binary-install resolver FIRST (resolves `process.execPath` via `realpathSync`, looks for `<dirname(dirname(execPath))>/bundle-default/index.yaml`) and falls through to the source-mode `import.meta.url` walk only when the binary branch misses. The function takes optional `{ execPath, metaUrl }` test seams; production passes nothing.

Rationale: In Bun `--compile` binaries, `import.meta.url` resolves to a virtual path inside the embedded filesystem — the existing source-mode walk produces a path that doesn't exist on disk. `process.execPath` always resolves to the actual on-disk executable in both modes. Trying binary FIRST means source-mode invocations (`bun src/main.ts`, `bun install -g`) hit the binary check, find no sibling `bundle-default/` next to the Bun runtime, fall through to the source walk, and behave exactly as before. Net behavioral change for any current install mode: zero. New behavior: Bun-compiled binaries with a sibling `bundle-default/` directory now resolve correctly.

Status: implemented (Phase 21 M1 — Task 1 commit). Plan: `plans/2026-05-22-phase-21-binary-distribution.md`.

## ADR P21-B — `sov upgrade` install-mode auto-detection by `~/.sov/bin/` prefix

Decision: `detectInstallMode({ execPath, homedir })` in `src/cli/upgrade.ts` returns `'binary'` iff `execPath` starts with `${homedir}/.sov/bin/`, else `'source'`. `buildUpgradeCommands()` consults this (overridable via `opts.mode`) and produces a single `['bash', '-c', 'curl ... | bash']` for binary mode or the existing `[uninstall, install]` pair for source mode. `BINARY_INSTALLER_URL` is a constant: `https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh`. Cache purge (`shouldPurgeCache`) short-circuits to `false` in binary mode (Bun's cache is irrelevant when we're not invoking Bun).

Rationale: Prefix-string check on `process.execPath` is sufficient because the binary install layout is fully under our control (we placed the binary there in install.sh). The escape hatch is `opts.mode` — pass `'source'` to force the legacy bun-install flow even on binary installs, or `'binary'` to force the public-installer flow. The constant URL is the contract with `sov-releases`; if we ever rename the public repo, this constant moves with it (and the public install.sh URL in user docs also moves).

Status: implemented (Phase 21 M1 — Task 2 commit). Plan: `plans/2026-05-22-phase-21-binary-distribution.md`.

```

- [ ] **Step 3: Commit**

```bash
git add DECISIONS.md
git commit -m "docs: ADRs P21-A + P21-B (binary-mode asset discovery + upgrade detection)"
```

---

## Task 10: Update top-level `README.md`

**Files:**
- Modify: `README.md`

**What changes:** add a "Binary install (recommended for non-developers)" section near the top, before the existing source-install instructions.

- [ ] **Step 1: Read the current README to find the install section**

```bash
grep -n "install\|Install\|INSTALL" /Users/julie/code/sovereign-ai-harness/README.md | head -10
```

- [ ] **Step 2: Insert the new section**

Locate the existing "Install" section (or the section that explains `bun install -g`). Insert this block AS A NEW SECTION just before it:

```markdown
## Install — binary distribution (recommended for non-developers)

The fastest way to try `sov` on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash
```

This installs a compiled binary under `~/.sov/` and adds it to your `PATH`.
No Bun, no Node, no git access required. Run `sov upgrade` to fetch the
latest release. Supported platforms: `darwin-arm64`, `darwin-x64`,
`linux-x64`. See [yevgetman/sov-releases](https://github.com/yevgetman/sov-releases)
for details.

The source-install path below remains the right choice for development,
contributors, or anyone who wants to modify the runtime.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add binary install section as the recommended path for non-developers"
```

---

## Task 11: Update canonical build plan in the docs repo

**Files:**
- Modify: `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`

**What changes:** the Phase 21 section currently reads "**Spec:** ... Seven ADRs locked (P21-01..07)." Update its status to **shipped / complete**, add the M1 close-out date, and reference this plan.

- [ ] **Step 1: Find the Phase 21 section in the docs repo**

```bash
grep -n "Phase 21" ~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md
```

- [ ] **Step 2: Update the section header to reflect status**

In `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`, change the section heading from:

```markdown
## Phase 21 — Binary distribution & portability (1 session)
```

to:

```markdown
## Phase 21 — Binary distribution & portability (1 session)

**Status:** M1 complete (2026-05-22). M2 (release automation) pending.
```

And add a final line right before the next `##` heading:

```markdown
**Plan:** `plans/2026-05-22-phase-21-binary-distribution.md` (in the harness repo).
```

- [ ] **Step 3: Commit in the docs repo**

```bash
cd ~/code/sovereign-ai-docs
git add harness/docs/runtime/harness-build-plan.md
git commit -m "docs: Phase 21 M1 complete — binary distribution shipped"
git push origin master
cd /Users/julie/code/sovereign-ai-harness
```

---

## Task 12: Write state snapshot + testing log entry + close-out commit

**Files:**
- Create: `docs/07-history/state/2026-05-22-phase-21-m1.md`
- Modify: `docs/06-testing/testing-log.md`
- Modify: `CLAUDE.md` + `AGENTS.md` (update the state snapshot pointer)

- [ ] **Step 1: Write the state snapshot**

Create `docs/07-history/state/2026-05-22-phase-21-m1.md`:

```markdown
# State of the build — Phase 21 M1 (binary distribution shipped)

**HEAD:** <SHA after Task 11 commits — fill in with `git rev-parse --short HEAD`>

**Chain since the ux-fixes round 5 close-out (`bf47564`, 2026-05-21):**
ux-fixes round 5 → stale-reference sweep (`7d949ef`, 2026-05-22) → Phase 21 M1
implementation chain (asset discovery → upgrade binary mode → release script →
README.binary.md → public repo + first release → smokes → ADRs → README +
canonical plan).

**Suite:** TS — **1958+ pass / 0 fail / 14 skip** (+9 from baseline: 3 asset-discovery cases + 6 upgrade-mode cases). Go unchanged. Lint + typecheck clean.

**ADRs:** P21-A (binary-install asset discovery), P21-B (upgrade-mode detection). The 7 spec ADRs (P21-01..07) live in `specs/2026-05-21-binary-distribution-design.md` — those are design decisions, not runtime-local ADRs.

**Phase 21 M1 closed.** M2 (release automation via GitHub Actions, optional code-signing/notarization) deferred — triggered when manual releases start feeling like friction.

## What shipped

- `src/bundle/defaultBundle.ts` — `shippedBundlePath()` tries `process.execPath`-relative discovery first, falls through to source-mode walk.
- `src/cli/upgrade.ts` — `detectInstallMode()` + binary-mode branch shelling out to `bash -c "curl ... | bash"` against the public installer URL.
- `scripts/release.ts` — local-only orchestrator: pre-flight → per-platform compile → tar → SHA256SUMS → `gh release create`. `--dry-run` supported.
- `README.binary.md` — per-tarball user-facing README.
- Public repo: `github.com/yevgetman/sov-releases` with `README.md`, `LICENSE.txt` (Sovereign AI, beta evaluation license), `install.sh`, `CHANGELOG.md`.
- First release: `v0.2.0` with three tarballs (`sov-darwin-arm64.tar.gz`, `sov-darwin-x64.tar.gz`, `sov-linux-x64.tar.gz`) + `SHA256SUMS`.
- Top-level `README.md` updated with "Binary install (recommended for non-developers)" section.
- Canonical build plan marked Phase 21 M1 as complete.

## Smokes passed

- **macOS host (darwin-arm64):** wipe → curl|bash → `sov --version` ok → TUI launches → `sov upgrade` re-runs installer idempotently.
- **Linux container (ubuntu:22.04, linux-x64):** apt install deps → curl|bash → `sov --version` ok → TUI boots + splash.
- **darwin-x64:** deferred to first Intel-Mac beta user's report.

## What does NOT work / known gaps after M1

After M1, the open backlog is **3 items**:

1. **`#17`** (P4, conditional) — eval-gated auto-promote.
2. **`#47`** (P4, cosmetic) — retire dead `transcript.go`.
3. **NEW Phase 21 M2** — GitHub Actions release automation + optional code-signing/notarization. Manual `bun run release v0.x.y` is the only release surface today; scheduled separately when friction warrants.

Phase 21 follow-ups (none scheduled):
- Windows support (separate phase if any beta user asks)
- linux-arm64 (separate phase if any beta user asks)
- Alpine/musl Linux (separate phase if any beta user asks)
- Apple Developer signing + notarization (~$99/yr, removes Gatekeeper warning)
- Homebrew tap

## Behavioral notes worth knowing next session

1. **Binary install lives at `~/.sov/`.** Layout: `bin/sov`, `bin/sov-tui`, `bundle-default/`, `version`. PATH-appended via `~/.zshrc` or `~/.bashrc` by `install.sh`.
2. **`sov upgrade` auto-detects mode** via `process.execPath` prefix. Override with `opts.mode` (programmatic) — no CLI flag added.
3. **Bun `--compile` works with `bun:sqlite`** (validated via pre-flight spike). No DB-path special-casing needed.
4. **Source mode is unchanged.** Every existing source-mode invocation (`bun src/main.ts`, `bun install -g git+ssh://...`) hits the binary-mode check, finds nothing relevant, falls through to the existing behavior bit-for-bit.
5. **Release script needs `SOV_RELEASES_PATH`** pointing at a local clone of `yevgetman/sov-releases` (where `LICENSE.txt` is sourced from). The script dies cleanly if unset.
6. **macOS Gatekeeper quarantine** still applies — unsigned binaries downloaded via curl prompt the user once. The installer prints the `xattr -d` workaround. Apple Dev signing is a Phase 21 follow-up.

## Postmortem-rule compliance check (Phase 21 M1)

The Phase 16.1 revert's Rules 1-4 apply primarily to foreground-surface refactors with active downstream consumers.

- **Rule 1 (deprecation soak)** — N/A. Phase 21 adds a new install/distribution path; no existing surface is deprecated. Source install remains.
- **Rule 2 (no helper deletion without consumer audit)** — Satisfied. Asset-discovery + upgrade-mode-detection are pure ADDITIONS via optional parameters; no helpers deleted.
- **Rule 3 (independent re-audit before claiming done)** — Satisfied via the smoke tests (macOS + Linux) — both happy-path verified end-to-end from clean machine to working `sov --version`.
- **Rule 4 (escape hatch during transition)** — Satisfied. `opts.mode` overrides install-mode detection on the upgrade side; source-mode resolver still wins on shippedBundlePath when execPath happens to fluke a false-positive (it can't, but the layered fallthrough provides safety).
```

- [ ] **Step 2: Append the testing log entry**

Edit `docs/06-testing/testing-log.md`. Insert a new entry at the TOP (after the intro paragraphs, before the existing first entry):

```markdown
## 2026-05-22 — Phase 21 M1 binary distribution (release pipeline + smokes)

**Scope:** First binary release of `sov`. New `scripts/release.ts` orchestrates per-platform Bun-compile + Go cross-compile + tar + `gh release create`. Two runtime-side patches: `shippedBundlePath()` learns a binary-install branch via `process.execPath`; `sov upgrade` detects binary mode via `~/.sov/bin/` prefix and re-runs the public installer.

**Tests added:**
- `tests/bundle/defaultBundle.test.ts` — 3 new cases for binary-mode resolution (sibling bundle present, fallthrough when missing, fallthrough on bad execPath).
- `tests/cli/upgrade.test.ts` — 6 new cases for `detectInstallMode` (binary vs source classification across 5 execPath shapes) + `buildUpgradeCommands` binary mode + `runUpgrade` dry-run.

**Commands:**
```
bun run lint && bun run typecheck && bun run test
# 1958 pass / 0 fail / 14 skip (baseline was 1955/0/14)

bun run release v0.2.0 --dry-run
# pre-flight ok; three tarballs in build/release/v0.2.0/; ~10 min wall time

bun run release v0.2.0
# real release; tag pushed; release live at github.com/yevgetman/sov-releases/releases/tag/v0.2.0
```

**Smoke results:**
- **macOS darwin-arm64 (host):** PASS — wipe `~/.sov` → `curl ... | bash` → install ok, PATH appended → `sov --version` prints tag → TUI launches + splash → `sov upgrade` re-runs installer idempotently.
- **Linux x86_64 (ubuntu:22.04 docker container):** PASS — apt install curl + ca-certificates → `curl ... | bash` → install ok → `sov --version` prints tag → TUI boots and shows splash.
- **macOS darwin-x64:** DEFERRED — no Intel Mac available; first Intel beta-user report is the validation.

**Result:** M1 shipped; v0.2.0 live; macOS + Linux smokes green; darwin-x64 deferred to field-report.

**Follow-ups:** M2 (GitHub Actions release automation + optional Apple Developer signing). Scheduled separately when manual-release friction warrants.

---

```

- [ ] **Step 3: Update CLAUDE.md + AGENTS.md current-state pointer**

Edit `CLAUDE.md`. In the "Session boot" section, find the line that says:

```markdown
3. **`docs/07-history/state/2026-05-21-ux-fixes-r5.md`** — most recent close-out snapshot ...
```

Replace with:

```markdown
3. **`docs/07-history/state/2026-05-22-phase-21-m1.md`** — most recent close-out snapshot (Phase 21 M1 shipped 2026-05-22 — binary distribution: Bun `--compile` for darwin-arm64/darwin-x64/linux-x64; Go cross-compile sibling; public `sov-releases` repo with `install.sh`; `sov upgrade` auto-detects binary mode; v0.2.0 live; macOS + Linux smokes green). Predecessor: `docs/07-history/state/2026-05-21-ux-fixes-r5.md` (ux-fixes rounds 3-5 close-out). Replaced each session — find the latest via `ls docs/07-history/state/*.md | sort -r | head -1`.
```

Also update the "Current state" table row pointing at the snapshot. Find:

```markdown
| [`docs/07-history/state/2026-05-21-ux-fixes-r5.md`](docs/07-history/state/2026-05-21-ux-fixes-r5.md) | **Canonical current-state snapshot — ...
```

Add a new row ABOVE it pointing at the new snapshot:

```markdown
| [`docs/07-history/state/2026-05-22-phase-21-m1.md`](docs/07-history/state/2026-05-22-phase-21-m1.md) | **Canonical current-state snapshot — Phase 21 M1 shipped 2026-05-22.** Binary distribution: per-platform Bun `--compile` + Go cross-compile + side-car bundle-default + public `sov-releases` repo with `curl ... | bash` installer. `sov upgrade` auto-detects binary mode. v0.2.0 live; macOS + Linux smokes pass; darwin-x64 deferred to first beta-user report. ADRs P21-A + P21-B locked. TS suite **1958+/0/14**; Go unchanged. |
```

Update the backlog summary line (the one that just got bumped to 2 in the stale-reference sweep):

Replace:

```markdown
| [`docs/08-roadmap/backlog/post-phase-13-4.md`](docs/08-roadmap/backlog/post-phase-13-4.md) | Open backlog (2 items): **#17 eval-gated auto-promote (P4, conditional)**; **#47 retire dead `transcript.go` (P4, cosmetic — added 2026-05-21 ux-fixes round 5)**. #40 closed M10.5; #41 + #43 + #44 + #45 + #46 closed 2026-05-19; #29 / #38 / #39 closed 2026-05-19 (audit + small inline fix). **Phase 16.1 closed with M13 (2026-05-20).** |
```

with:

```markdown
| [`docs/08-roadmap/backlog/post-phase-13-4.md`](docs/08-roadmap/backlog/post-phase-13-4.md) | Open backlog (3 items): **#17 eval-gated auto-promote (P4, conditional)**; **#47 retire dead `transcript.go` (P4, cosmetic)**; **Phase 21 M2 release automation (P3, scheduled separately — GitHub Actions + optional code-signing)**. #40 closed M10.5; #41 + #43 + #44 + #45 + #46 closed 2026-05-19; #29 / #38 / #39 closed 2026-05-19. **Phase 16.1 closed with M13 (2026-05-20); Phase 21 M1 closed (2026-05-22).** |
```

- [ ] **Step 4: Mirror to AGENTS.md (byte-identical)**

```bash
diff CLAUDE.md AGENTS.md
```

Any differences shown are the changes you made in step 3. Apply the SAME edits to AGENTS.md so the two files are byte-identical again. Verify:

```bash
diff CLAUDE.md AGENTS.md && echo "IDENTICAL"
```

- [ ] **Step 5: Add a Phase 21 M2 entry to the backlog**

Edit `docs/08-roadmap/backlog/post-phase-13-4.md`. Update the opening paragraph to reflect the new state (3 items now), and add a new P3 entry:

In the priority section after the existing `47. Retire dead packages/tui/...` block, add:

```markdown
P3 (Phase 21 follow-up):
48. **Phase 21 M2 — GitHub Actions release automation + optional code-signing.** The manual `bun run release v0.x.y` flow shipped in Phase 21 M1 works end-to-end but takes ~10 min of dedicated attention per release. M2 moves the release pipeline into a GitHub Actions workflow inside `sov-releases` (or a private workflow that pushes to it via deploy key); optionally adds macOS code-signing + notarization (requires Apple Developer Program enrollment, ~$99/yr); optionally adds a homebrew tap. Trigger: when manual releases start feeling like friction. Spec already covers M2 in `specs/2026-05-21-binary-distribution-design.md` §2. Effort: ~3-4 wall hours per the spec.
```

Also update the "Last sync" paragraph at the top to mention Phase 21 M1 shipped.

- [ ] **Step 6: Update the snapshot HEAD placeholder**

Edit `docs/07-history/state/2026-05-22-phase-21-m1.md`. Replace the `<SHA after Task 11 commits ...>` placeholder at the top with the actual current short SHA:

```bash
SHA="$(git rev-parse --short HEAD)"
# Then edit the file to put SHA in place of the placeholder
```

- [ ] **Step 7: Run the full pre-commit gate one more time**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: 1958+/0/14, lint clean, typecheck clean.

- [ ] **Step 8: Final commit**

```bash
git add docs/07-history/state/2026-05-22-phase-21-m1.md \
        docs/06-testing/testing-log.md \
        docs/08-roadmap/backlog/post-phase-13-4.md \
        CLAUDE.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs: Phase 21 M1 close-out — state snapshot + testing log + index pointers

State snapshot at docs/07-history/state/2026-05-22-phase-21-m1.md replaces the ux-fixes
round 5 snapshot as the canonical current-state pointer. Testing log
records the release pipeline run + macOS / Linux smoke passes. CLAUDE.md +
AGENTS.md byte-identical; backlog summary bumped to 3 items (added Phase
21 M2 release automation as P3). M2 logged in post-phase-13-4 backlog as
item #48.
EOF
)"
```

- [ ] **Step 9: Push everything**

```bash
git push origin master
```

- [ ] **Step 10: Final verification**

```bash
git status   # clean
git log -5 --oneline   # five recent commits visible: Tasks 1, 2, 3, 4, 6, 8/9, 10, 12 (depending on consolidation)
gh release view v0.2.0 --repo yevgetman/sov-releases   # release live
```

---

## Final summary

After Task 12, Phase 21 M1 is complete:

- **Public install surface:** `curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash` works on darwin-arm64 + linux-x64 (verified). darwin-x64 build present but unverified pending first Intel-Mac beta user.
- **Runtime changes:** 2 small files (`src/bundle/defaultBundle.ts` + `src/cli/upgrade.ts`); 9 new tests; 2 new ADRs; suite **1958+/0/14** green.
- **Release tooling:** `bun run release v0.x.y` ships a release end-to-end in ~10 minutes wall time.
- **Docs:** state snapshot rotated; canonical build plan updated; backlog logs Phase 21 M2 as the follow-up; CLAUDE.md + AGENTS.md current.

Next session can pick up:
- **Phase 21 M2** (GitHub Actions automation, code-signing) — when manual flow feels like friction.
- **Backlog #47** (transcript.go cleanup, ~30 min).
- **Backlog #17** (eval-gated auto-promote, conditional).
- **A new phase entirely** (Phase 16.5 Telegram, Phase 17 cron, etc. — none specced yet).

No single direction is forcing. Phase 21 M1 was self-contained; subsequent work resumes from a clean slate.
